#!/usr/bin/env bash
# Write web/config.js from the running local Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(npx supabase status -o env 2>/dev/null)"
cat > web/config.js <<EOF
export const SUPABASE_URL = '$API_URL';
export const SUPABASE_KEY = '$ANON_KEY';
EOF
echo "Wrote web/config.js for $API_URL"
