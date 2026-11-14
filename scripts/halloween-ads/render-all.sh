#!/bin/bash
cd "$(dirname "$0")"
N="${NODE_BIN:-node}"
ALL="$(seq -f V%02g 1 16 | tr "
" " ")"
set -- $ALL
while [ $# -gt 0 ]; do
  for i in 1 2 3; do [ -n "$1" ] && { "$N" build.mjs $1 > work/$1.log 2>&1 & shift; }; done
  wait
done
echo ALLDONE > work/alldone.txt
