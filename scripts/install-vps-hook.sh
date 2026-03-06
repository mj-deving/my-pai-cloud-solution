#!/bin/bash
# install-vps-hook.sh — Install pre-push hook on VPS to block direct pushes to main
# Usage: bash scripts/install-vps-hook.sh
#
# This prevents Cloud Isidore from pushing directly to main.
# Cloud must use cloud/* branches instead.

set -euo pipefail

VPS_HOST="isidore_cloud"
PROJECT_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"

echo "Installing pre-push hook on VPS..."

ssh "$VPS_HOST" "cat > $PROJECT_DIR/.git/hooks/pre-push << 'HOOK'
#!/bin/bash
# pre-push hook — Block direct pushes to main
# Cloud Isidore must push to cloud/* branches only.

while read local_ref local_sha remote_ref remote_sha; do
    if echo \"\$remote_ref\" | grep -q 'refs/heads/main'; then
        echo \"\"
        echo \"ERROR: Direct push to main is blocked.\"
        echo \"\"
        echo \"Push to a cloud/* branch instead:\"
        echo \"  git checkout -b cloud/<description>\"
        echo \"  git push -u origin cloud/<description>\"
        echo \"\"
        echo \"Marius will review and merge to main.\"
        echo \"\"
        exit 1
    fi
done

exit 0
HOOK
chmod +x $PROJECT_DIR/.git/hooks/pre-push"

echo "Pre-push hook installed. Testing..."

# Verify hook exists and is executable
ssh "$VPS_HOST" "test -x $PROJECT_DIR/.git/hooks/pre-push && echo 'Hook is executable ✓' || echo 'Hook installation FAILED'"

echo ""
echo "Cloud Isidore can now only push to cloud/* branches."
echo "Direct pushes to main will be rejected."
