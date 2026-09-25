#!/bin/bash
for v in "$@"; do f=/workspace/$v.log; echo "== $v reg_events=$(grep -c 'Registering image' $f) last: $(grep -E 'Registering image|num_reg_frames|Retriangulation|Global bundle|Keeping|Finding good initial|Model' $f | tail -2 | cut -c40-200 | tr '\n' '|')"; done
