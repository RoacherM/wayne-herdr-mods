#!/bin/sh
# One input box, end to end: local relay + dev/fake-desktop.mjs + the nsh app (headless) + real Claude Code.
#   npm run relay:dev  (another shell);  sh dev/live-smoke.sh
cd "$(dirname "$0")/.."
pkill -f dev/fake-desktop.mjs; HC_SESSION=relay-ui hc server stop >/dev/null 2>&1; sleep 1
(node dev/fake-desktop.mjs > /tmp/fake.log 2>&1 &)
for i in $(seq 1 30); do grep -q LINK /tmp/fake.log && break; sleep 1; done
grep -o 'LINK .*' /tmp/fake.log | cut -c6- | python3 -c 'import sys,json;print(json.dumps({"link":sys.stdin.read().strip()}))' > ios/probe/link.json
addr() { HC_SESSION=relay-ui hc ls | python3 -c "import sys,json;print([t['address'] for t in json.load(sys.stdin)['terminals'] if t.get('where')=='$1'][0])"; }
screen() { HC_SESSION=relay-ui hc read "$(addr "$1")" | grep -av '^\s*$' | grep -v 'Transcript saving\|bypass permissions\|^ *Opus' | tail -"$2"; }
cd ios && nsh test probe/live.test.tsx 2>&1 | while IFS= read -r l; do
  case "$l" in
    *"CHECK fake-"*) echo "=== ${l#*CHECK }"; screen 'herdr-relay · claude' 4 ;;
    *CHECK*) echo "=== ${l#*CHECK }"; screen 'herdr-relay · shell' 8 ;;
    *CHECK*) ;; *) echo "$l" ;;
  esac
done
cd .. && pkill -f dev/fake-desktop.mjs; HC_SESSION=relay-ui hc server stop >/dev/null 2>&1
