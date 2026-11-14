#!/usr/bin/env bash
# Write web/config.js for the linked Supabase project, or the local one if none is linked.
set -euo pipefail
cd "$(dirname "$0")/.."
if ref=$(cat supabase/.temp/project-ref 2>/dev/null); then
  API_URL="https://$ref.supabase.co"
  ANON_KEY=$(npx supabase projects api-keys --project-ref "$ref" -o json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(k=>k.name==="anon").api_key))')
else
  eval "$(npx supabase status -o env 2>/dev/null)"
fi
cat > web/config.js <<EOF
export const SUPABASE_URL = '$API_URL';
export const SUPABASE_KEY = '$ANON_KEY';
EOF
echo "Wrote web/config.js for $API_URL"
