"""study_report.summarize must match viewer/src/study.js (same fixture)."""
from splattour.study_report import summarize


def test_summary_matches_viewer_definition():
    ev = [{"t": 0, "e": "start", "scene": "s", "mode": "splat"}, {"t": 100, "e": "arrive", "node": "n0"}, {"t": 200, "e": "pose", "p": [0, 0, 0]},
          {"t": 1200, "e": "depart", "to": "n1"}, {"t": 1300, "e": "pose", "p": [3, 0, 4]}, {"t": 2500, "e": "arrive", "node": "n1"},
          {"t": 2600, "e": "zoom", "fov": 40}, {"t": 3000, "e": "approach"}, {"t": 5000, "e": "pose", "p": [3, 0, 4]}]
    s = summarize(ev)
    assert (s["duration_s"], s["moves"], s["unique_nodes"], s["path_m"], s["zooms"], s["approaches"]) == (5.0, 1, 2, 5.0, 1, 1)
    assert s["mean_dwell_s"] == 2.5  # (2.4 + 2.5) / 2 → 2.45 → rounds to 2.5 (half-to-even aside)


if __name__ == "__main__":
    test_summary_matches_viewer_definition()
    print("ok")
