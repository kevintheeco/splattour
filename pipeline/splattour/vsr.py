"""Multi-frame video super-resolution (BasicVSR++ / RealBasicVSR) in plain PyTorch + torchvision.

No mmcv/mmagic: the networks are re-implemented from the OpenMMLab (mmagic, Apache-2.0) code and load
the official OpenMMLab checkpoints with strict=True (every weight must match, so a wrong layer fails loudly).
Modulated deformable conv (DCNv2) = torchvision.ops.deform_conv2d with a mask (same offset layout as mmcv).

Weights (docs/PANO360.md, "VSR 시험"), data/pano360/weights/:
  BasicVSR++ REDS4 BI x4  basicvsr_plusplus_c64n7_8x1_600k_reds4_20210217-db622b2f.pth
  RealBasicVSR x4 (GAN)   realbasicvsr_c64b20_1x30x8_lr5e-5_150k_reds_20211104-52f77c2c.pth
  from https://download.openmmlab.com/mmediting/restorers/..., sha256 prefix = the file-name suffix.

Input: frames [T, 3, H, W] RGB float 0..1 (the same virtual view over consecutive video frames).
Output: [T, 3, 4H, 4W]. Both are x4 networks; `upscale(..., scale=2)` area-downsamples the x4 result.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.ops import deform_conv2d


def flow_warp(x, flow, padding_mode="zeros"):
    n, _, h, w = x.shape
    gy, gx = torch.meshgrid(torch.arange(h, device=x.device, dtype=x.dtype), torch.arange(w, device=x.device, dtype=x.dtype), indexing="ij")
    g = torch.stack((gx, gy), 2)[None] + flow
    gx = 2.0 * g[..., 0] / max(w - 1, 1) - 1.0
    gy = 2.0 * g[..., 1] / max(h - 1, 1) - 1.0
    return F.grid_sample(x, torch.stack((gx, gy), 3), mode="bilinear", padding_mode=padding_mode, align_corners=True)


class ResidualBlockNoBN(nn.Module):
    def __init__(self, c=64):
        super().__init__()
        self.conv1 = nn.Conv2d(c, c, 3, 1, 1)
        self.conv2 = nn.Conv2d(c, c, 3, 1, 1)

    def forward(self, x):
        return x + self.conv2(F.relu(self.conv1(x)))


class ResidualBlocksWithInputConv(nn.Module):
    def __init__(self, cin, cout=64, n=30):
        super().__init__()
        self.main = nn.Sequential(nn.Conv2d(cin, cout, 3, 1, 1), nn.LeakyReLU(0.1, True), nn.Sequential(*[ResidualBlockNoBN(cout) for _ in range(n)]))

    def forward(self, x):
        return self.main(x)


class PixelShufflePack(nn.Module):
    def __init__(self, cin, cout, scale, k=3):
        super().__init__()
        self.scale = scale
        self.upsample_conv = nn.Conv2d(cin, cout * scale * scale, k, padding=(k - 1) // 2)

    def forward(self, x):
        return F.pixel_shuffle(self.upsample_conv(x), self.scale)


class _ConvModule(nn.Module):
    def __init__(self, cin, cout, act=True):
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, 7, 1, 3)
        self.act = act

    def forward(self, x):
        x = self.conv(x)
        return F.relu(x) if self.act else x


class SPyNetBasicModule(nn.Module):
    def __init__(self):
        super().__init__()
        self.basic_module = nn.Sequential(_ConvModule(8, 32), _ConvModule(32, 64), _ConvModule(64, 32), _ConvModule(32, 16), _ConvModule(16, 2, False))

    def forward(self, x):
        return self.basic_module(x)


class SPyNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.basic_module = nn.ModuleList([SPyNetBasicModule() for _ in range(6)])
        self.register_buffer("mean", torch.Tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.Tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def compute_flow(self, ref, supp):
        n, _, h, w = ref.shape
        ref = [(ref - self.mean) / self.std]
        supp = [(supp - self.mean) / self.std]
        for _ in range(5):
            ref.append(F.avg_pool2d(ref[-1], 2, 2, count_include_pad=False))
            supp.append(F.avg_pool2d(supp[-1], 2, 2, count_include_pad=False))
        ref, supp = ref[::-1], supp[::-1]
        flow = ref[0].new_zeros(n, 2, h // 32, w // 32)
        for lv in range(len(ref)):
            up = flow if lv == 0 else F.interpolate(flow, scale_factor=2, mode="bilinear", align_corners=True) * 2.0
            flow = up + self.basic_module[lv](torch.cat([ref[lv], flow_warp(supp[lv], up.permute(0, 2, 3, 1), "border"), up], 1))
        return flow

    def forward(self, ref, supp):
        h, w = ref.shape[2:4]
        wu, hu = (w + 31) // 32 * 32, (h + 31) // 32 * 32
        ref = F.interpolate(ref, size=(hu, wu), mode="bilinear", align_corners=False)
        supp = F.interpolate(supp, size=(hu, wu), mode="bilinear", align_corners=False)
        flow = F.interpolate(self.compute_flow(ref, supp), size=(h, w), mode="bilinear", align_corners=False)
        flow[:, 0] *= w / wu
        flow[:, 1] *= h / hu
        return flow


def _flows(spynet, lqs):
    t = lqs.shape[0]
    a, b = lqs[:-1], lqs[1:]
    back = spynet(a, b)  # warps frame i+1 to i
    fwd = spynet(b, a)   # warps frame i to i+1
    return fwd, back


class SecondOrderDeformableAlignment(nn.Module):
    def __init__(self, cin, cout, groups=16, max_mag=10):
        super().__init__()
        self.weight = nn.Parameter(torch.zeros(cout, cin, 3, 3))
        self.bias = nn.Parameter(torch.zeros(cout))
        self.groups, self.max_mag = groups, max_mag
        self.conv_offset = nn.Sequential(nn.Conv2d(3 * cout + 4, cout, 3, 1, 1), nn.LeakyReLU(0.1, True), nn.Conv2d(cout, cout, 3, 1, 1),
                                         nn.LeakyReLU(0.1, True), nn.Conv2d(cout, cout, 3, 1, 1), nn.LeakyReLU(0.1, True),
                                         nn.Conv2d(cout, 27 * groups, 3, 1, 1))

    def forward(self, x, extra, f1, f2):
        out = self.conv_offset(torch.cat([extra, f1, f2], 1))
        o1, o2, mask = torch.chunk(out, 3, 1)
        off = self.max_mag * torch.tanh(torch.cat((o1, o2), 1))
        a, b = torch.chunk(off, 2, 1)
        a = a + f1.flip(1).repeat(1, a.size(1) // 2, 1, 1)
        b = b + f2.flip(1).repeat(1, b.size(1) // 2, 1, 1)
        return deform_conv2d(x, torch.cat([a, b], 1), self.weight, self.bias, padding=1, mask=torch.sigmoid(mask))


class BasicVSRPlusPlus(nn.Module):
    def __init__(self, mid=64, nb=7):
        super().__init__()
        self.mid = mid
        self.spynet = SPyNet()
        self.feat_extract = ResidualBlocksWithInputConv(3, mid, 5)
        self.deform_align, self.backbone = nn.ModuleDict(), nn.ModuleDict()
        self.mods = ["backward_1", "forward_1", "backward_2", "forward_2"]
        for i, m in enumerate(self.mods):
            self.deform_align[m] = SecondOrderDeformableAlignment(2 * mid, mid)
            self.backbone[m] = ResidualBlocksWithInputConv((2 + i) * mid, mid, nb)
        self.reconstruction = ResidualBlocksWithInputConv(5 * mid, mid, 5)
        self.upsample1 = PixelShufflePack(mid, mid, 2)
        self.upsample2 = PixelShufflePack(mid, 64, 2)
        self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)

    def propagate(self, feats, flows, name):
        t = flows.shape[0]
        frame_idx = list(range(t + 1))
        flow_idx = list(range(-1, t))
        mapping = list(range(len(feats["spatial"])))
        mapping += mapping[::-1]
        if "backward" in name:
            frame_idx = frame_idx[::-1]
            flow_idx = frame_idx
        n, _, h, w = feats["spatial"][0].shape
        prop = flows.new_zeros(n, self.mid, h, w)
        for i, idx in enumerate(frame_idx):
            cur = feats["spatial"][mapping[idx]]
            if i > 0:
                f1 = flows[flow_idx[i]][None]
                c1 = flow_warp(prop, f1.permute(0, 2, 3, 1))
                p2 = torch.zeros_like(prop)
                f2 = torch.zeros_like(f1)
                c2 = torch.zeros_like(c1)
                if i > 1:
                    p2 = feats[name][-2]
                    f2 = flows[flow_idx[i - 1]][None]
                    f2 = f1 + flow_warp(f2, f1.permute(0, 2, 3, 1))
                    c2 = flow_warp(p2, f2.permute(0, 2, 3, 1))
                prop = self.deform_align[name](torch.cat([prop, p2], 1), torch.cat([c1, cur, c2], 1), f1, f2)
            feat = [cur] + [feats[k][idx] for k in feats if k not in ("spatial", name)] + [prop]
            prop = prop + self.backbone[name](torch.cat(feat, 1))
            feats[name].append(prop)
        if "backward" in name:
            feats[name] = feats[name][::-1]
        return feats

    def forward(self, lqs):  # [T,3,H,W]
        t = lqs.shape[0]
        feats = {"spatial": [self.feat_extract(lqs[i:i + 1]) for i in range(t)]}
        fwd, back = _flows(self.spynet, lqs)
        for it in (1, 2):
            for d in ("backward", "forward"):
                m = f"{d}_{it}"
                feats[m] = []
                feats = self.propagate(feats, back if d == "backward" else fwd, m)
        outs = []
        for i in range(t):
            hr = torch.cat([feats["spatial"][i]] + [feats[k][i] for k in self.mods], 1)
            hr = self.reconstruction(hr)
            hr = F.leaky_relu(self.upsample1(hr), 0.1)
            hr = F.leaky_relu(self.upsample2(hr), 0.1)
            hr = F.leaky_relu(self.conv_hr(hr), 0.1)
            hr = self.conv_last(hr) + F.interpolate(lqs[i:i + 1], scale_factor=4, mode="bilinear", align_corners=False)
            outs.append(hr)
        return torch.cat(outs, 0)


class BasicVSRNet(nn.Module):
    def __init__(self, mid=64, nb=20):
        super().__init__()
        self.mid = mid
        self.spynet = SPyNet()
        self.backward_resblocks = ResidualBlocksWithInputConv(mid + 3, mid, nb)
        self.forward_resblocks = ResidualBlocksWithInputConv(mid + 3, mid, nb)
        self.fusion = nn.Conv2d(2 * mid, mid, 1, 1, 0)
        self.upsample1 = PixelShufflePack(mid, mid, 2)
        self.upsample2 = PixelShufflePack(mid, 64, 2)
        self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)

    def forward(self, lrs):
        t, _, h, w = lrs.shape
        fwd, back = _flows(self.spynet, lrs)
        outs = []
        prop = lrs.new_zeros(1, self.mid, h, w)
        for i in range(t - 1, -1, -1):
            if i < t - 1:
                prop = flow_warp(prop, back[i:i + 1].permute(0, 2, 3, 1))
            prop = self.backward_resblocks(torch.cat([lrs[i:i + 1], prop], 1))
            outs.append(prop)
        outs = outs[::-1]
        prop = torch.zeros_like(prop)
        res = []
        for i in range(t):
            if i > 0:
                prop = flow_warp(prop, fwd[i - 1:i].permute(0, 2, 3, 1))
            prop = self.forward_resblocks(torch.cat([lrs[i:i + 1], prop], 1))
            o = F.leaky_relu(self.fusion(torch.cat([outs[i], prop], 1)), 0.1)
            o = F.leaky_relu(self.upsample1(o), 0.1)
            o = F.leaky_relu(self.upsample2(o), 0.1)
            o = F.leaky_relu(self.conv_hr(o), 0.1)
            res.append(self.conv_last(o) + F.interpolate(lrs[i:i + 1], scale_factor=4, mode="bilinear", align_corners=False))
        return torch.cat(res, 0)


class RealBasicVSR(nn.Module):
    def __init__(self):
        super().__init__()
        self.image_cleaning = nn.Sequential(ResidualBlocksWithInputConv(3, 64, 20), nn.Conv2d(64, 3, 3, 1, 1, bias=True))
        self.basicvsr = BasicVSRNet(64, 20)

    def forward(self, lqs, max_iter=3, threshold=1.0):
        for _ in range(max_iter):
            r = self.image_cleaning(lqs)
            lqs = lqs + r
            if torch.mean(torch.abs(r)) < threshold:
                break
        return self.basicvsr(lqs)


class _RDB(nn.Module):
    def __init__(self, f=64, g=32):
        super().__init__()
        self.conv1 = nn.Conv2d(f, g, 3, 1, 1)
        self.conv2 = nn.Conv2d(f + g, g, 3, 1, 1)
        self.conv3 = nn.Conv2d(f + 2 * g, g, 3, 1, 1)
        self.conv4 = nn.Conv2d(f + 3 * g, g, 3, 1, 1)
        self.conv5 = nn.Conv2d(f + 4 * g, f, 3, 1, 1)

    def forward(self, x):
        l = lambda t: F.leaky_relu(t, 0.2)  # noqa: E731
        x1 = l(self.conv1(x))
        x2 = l(self.conv2(torch.cat((x, x1), 1)))
        x3 = l(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = l(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        return self.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x


class _RRDB(nn.Module):
    def __init__(self, f=64):
        super().__init__()
        self.rdb1, self.rdb2, self.rdb3 = _RDB(f), _RDB(f), _RDB(f)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNetX2(nn.Module):
    """Real-ESRGAN x2plus (BasicSR RRDBNet, scale 2 = pixel-unshuffle input), single image, for comparison."""
    def __init__(self, nb=23):
        super().__init__()
        self.conv_first = nn.Conv2d(12, 64, 3, 1, 1)
        self.body = nn.Sequential(*[_RRDB() for _ in range(nb)])
        self.conv_body = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)

    def forward(self, x):
        l = lambda t: F.leaky_relu(t, 0.2)  # noqa: E731
        f = self.conv_first(F.pixel_unshuffle(x, 2))
        f = f + self.conv_body(self.body(f))
        f = l(self.conv_up1(F.interpolate(f, scale_factor=2, mode="nearest")))
        f = l(self.conv_up2(F.interpolate(f, scale_factor=2, mode="nearest")))
        return self.conv_last(l(self.conv_hr(f)))


def load_esrgan_x2(path: Path) -> nn.Module:
    ck = torch.load(str(path), map_location="cpu", weights_only=False)
    net = RRDBNetX2()
    net.load_state_dict(ck.get("params_ema", ck.get("params", ck)), strict=True)
    return net.eval()


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load(kind: str, path: Path) -> nn.Module:
    """kind: 'basicvsrpp' | 'realbasicvsr'. Checks that the sha256 starts with the 8 hex in the file name."""
    suffix = Path(path).stem.rsplit("-", 1)[-1]
    if len(suffix) == 8 and not sha256(Path(path)).startswith(suffix):
        raise RuntimeError(f"{path}: sha256 does not start with {suffix}")
    net = BasicVSRPlusPlus() if kind == "basicvsrpp" else RealBasicVSR()
    ck = torch.load(str(path), map_location="cpu", weights_only=False)
    sd = {k[len("generator."):]: v for k, v in ck.get("state_dict", ck).items() if k.startswith("generator.")}
    net.load_state_dict(sd, strict=True)
    return net.eval()


@torch.no_grad()
def upscale(net: nn.Module, frames: torch.Tensor, scale: int = 4) -> torch.Tensor:
    """frames [T,3,H,W] 0..1 -> [T,3,sH,sW] (x4 network, area-downsampled for scale 2)."""
    y = net(frames).clamp(0, 1)
    if scale != 4:
        y = F.interpolate(y, size=(frames.shape[2] * scale, frames.shape[3] * scale), mode="area")
    return y
