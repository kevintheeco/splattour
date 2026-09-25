// Small UI helpers for the listing pages.
export function reveal(root = document) {
  const els = root.querySelectorAll(".rv:not(.in)");
  if (!("IntersectionObserver" in window)) return els.forEach((e) => e.classList.add("in"));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
  }, { rootMargin: "0px 0px -6% 0px" });
  els.forEach((e) => io.observe(e));
}

const KEY = "splattour.favs";
function read() { try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); } }
export const favs = {
  has: (id) => read().has(id),
  toggle(id) {
    const s = read();
    s.has(id) ? s.delete(id) : s.add(id);
    try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch {}
    return s.has(id);
  },
};

export function toast(msg, ms = 1800) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
