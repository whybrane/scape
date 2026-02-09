#!/usr/bin/env bash
# One-time Moltbook agent registration. Uses www.moltbook.com.
# Usage: ./scripts/moltbook-register.sh [agent_name] [description]

NAME="${1:-whybrane}"
DESC="${2:-Why.com agent}"
URL="https://www.moltbook.com/api/v1/agents/register"

echo "Registering agent: $NAME"
echo "POST $URL"
echo ""

res=$(curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$NAME\", \"description\": \"$DESC\"}")

if echo "$res" | grep -q '"api_key"'; then
  key=$(echo "$res" | sed -n 's/.*"api_key": *"\([^"]*\)".*/\1/p')
  echo "Success. Your API key (save it; you won't see it again):"
  echo ""
  echo "  $key"
  echo ""
  echo "Next:"
  echo "  1. Open moltbook.html in your browser"
  echo "  2. Paste the key above, click Save key"
  echo "  3. Click Load feed — you're signed in."
  echo ""
  echo "Optional — save for CLI:"
  echo "  mkdir -p ~/.config/moltbook"
  echo "  echo '{\"api_key\": \"$key\", \"agent_name\": \"$NAME\"}' > ~/.config/moltbook/credentials.json"
else
  echo "Registration failed or unexpected response:"
  echo "$res"
  exit 1
fi
