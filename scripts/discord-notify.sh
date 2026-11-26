#!/usr/bin/env bash
# Post a GitHub release to a Discord webhook as one embed. Never fails the caller (a Discord outage must not fail a release).
# Env: DISCORD_WEBHOOK (empty -> skip), TAG, CHANNEL (stable|dev), GH_TOKEN, GH_REPO (owner/name), SHA (optional).
# All text is built with jq --arg, never interpolated into JSON or shell.
set -uo pipefail

if [ -z "${DISCORD_WEBHOOK:-}" ]; then
  echo "::warning::Discord webhook secret not set, skipping notification"
  exit 0
fi
: "${TAG:?}" "${GH_REPO:?}"
CHANNEL="${CHANNEL:-stable}"

rel=$(gh release view "$TAG" --json url,body,isPrerelease,name) || { echo "::warning::release $TAG not found, no Discord post"; exit 0; }
url=$(jq -r .url <<<"$rel")
body=$(jq -r '.body // ""' <<<"$rel")

# Previous release of the same channel, for a compare link (best effort).
is_pre=$([ "$CHANNEL" = dev ] && echo true || echo false)
prev=$(gh release list --limit 100 --exclude-drafts --json tagName,isPrerelease,createdAt 2>/dev/null \
  | jq -r --arg tag "$TAG" --argjson pre "$is_pre" \
    '[.[] | select(.isPrerelease == $pre)] | sort_by(.createdAt) | reverse
     | (map(.tagName) | index($tag)) as $i | if $i == null then empty else .[$i+1].tagName // empty end') || prev=""

payload=$(jq -n \
  --arg tag "$TAG" --arg url "$url" --arg body "$body" --arg channel "$CHANNEL" \
  --arg repo "$GH_REPO" --arg sha "${SHA:-}" --arg prev "$prev" '
  def clip($n): if length > $n then .[0:($n - 1)] + "…" else . end;
  ($repo | "https://github.com/" + .) as $gh
  | (if $prev != "" then "[Compare changes](\($gh)/compare/\($prev)...\($tag))"
     elif $sha != "" then "[Commit \($sha[0:7])](\($gh)/commit/\($sha))" else "" end) as $links
  | ($body | gsub("\r"; "") | gsub("\n{3,}"; "\n\n") | gsub("^\\s+|\\s+$"; "")) as $notes
  | (if $links == "" then "" else "\n\n" + $links end) as $foot
  | { username: "RSI+ releases",
      allowed_mentions: { parse: [] },
      embeds: [ {
        title: ((if $channel == "dev" then "RSI+ dev build " else "RSI+ " end) + $tag) | clip(256),
        url: $url,
        color: (if $channel == "dev" then 15105570 else 5763719 end),
        description: ((($notes | clip(3500)) + $foot) | clip(4096)),
        footer: { text: ($repo + (if $channel == "dev" then " · prerelease" else "" end)) }
      } ] }') || { echo "::warning::could not build Discord payload"; exit 0; }

# Webhook URL goes through a curl config on stdin so it never shows in argv or logs.
code=$(printf 'url = "%s"\n' "$DISCORD_WEBHOOK" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --retry 2 \
  -H 'Content-Type: application/json' -d "$payload" -K - 2>/dev/null) || code=000
case "$code" in
  2??) echo "Discord notified ($CHANNEL, $TAG)" ;;
  *) echo "::warning::Discord post failed (HTTP $code), release unaffected" ;;
esac
exit 0
