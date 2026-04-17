#!/bin/bash

# Exit on error
set -e

# Require version bump type (patch, minor, major, rc)
BUMP_TYPE=$1
SKIP_TESTS=false

if [[ "$2" == "--no-test" ]]; then
  SKIP_TESTS=true
fi

if [[ -z "$BUMP_TYPE" || ! "$BUMP_TYPE" =~ ^(patch|minor|major|rc)$ ]]; then
  echo "Usage: npm run release -- <patch|minor|major|rc> [--no-test]"
  echo ""
  echo "  patch   — 0.1.0 → 0.1.1          (published as latest)"
  echo "  minor   — 0.1.0 → 0.2.0          (published as latest)"
  echo "  major   — 0.1.0 → 1.0.0          (published as latest)"
  echo "  rc      — 0.1.0 → 0.1.1-rc.0     (published as rc, not latest)"
  echo ""
  echo "  --no-test   skip the test suite"
  exit 1
fi

echo "Verifying working directory is clean..."
if [[ $(git status --porcelain) ]]; then
  echo "Error: Working directory is not clean. Please commit or stash your changes first."
  exit 1
fi

if [[ "$SKIP_TESTS" == "true" ]]; then
  echo "Skipping test suite (--no-test)..."
else
  echo "Running test suite to ensure stability..."
  npm test
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")

if [[ "$BUMP_TYPE" == "rc" ]]; then
  NEXT_VERSION=$(node -p "
    const v = '$CURRENT_VERSION'.split('-')[0].split('.');
    const pre = '$CURRENT_VERSION'.includes('-rc.') ? parseInt('$CURRENT_VERSION'.split('-rc.')[1]) + 1 : 0;
    const base = '$CURRENT_VERSION'.includes('-rc.') ? '$CURRENT_VERSION'.split('-rc.')[0] : v[0]+'.'+v[1]+'.'+(parseInt(v[2])+1);
    base+'-rc.'+pre
  ")
  TAG="rc"
else
  NEXT_VERSION=$(node -p "
    const v = '$CURRENT_VERSION'.split('.').map(Number);
    if ('$BUMP_TYPE' === 'major') { v[0]++; v[1]=0; v[2]=0; }
    else if ('$BUMP_TYPE' === 'minor') { v[1]++; v[2]=0; }
    else { v[2]++; }
    v.join('.')
  ")
  TAG="latest"
fi

echo ""
echo "========================================================="
echo "  Current version : $CURRENT_VERSION"
echo "  New version     : $NEXT_VERSION"
echo "  NPM tag         : $TAG"
echo "========================================================="
read -p "Publish cfnless@$NEXT_VERSION? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Checking NPM authentication..."
if ! NPM_USER=$(npm whoami 2>&1); then
  echo "Error: Not logged in to NPM. Run 'npm login' or set NPM_TOKEN."
  exit 1
fi
echo "Logged in as: $NPM_USER"


if [[ "$BUMP_TYPE" == "rc" ]]; then
  echo "Bumping prerelease version (rc)..."
  npm version prerelease --preid=rc

  echo "Publishing to NPM with rc tag..."
  npm publish --tag rc 
  echo "Pushing tag to GitHub..."
  git push --follow-tags

  echo "========================================================="
  echo "Success! cfnless@$NEXT_VERSION published under the 'rc' tag."
  echo "Install with: npm install cfnless@rc"
  echo "========================================================="
else
  echo "Bumping version ($BUMP_TYPE)..."
  npm version $BUMP_TYPE

  echo "Publishing to NPM..."
  npm publish 
  echo "Pushing tag to GitHub..."
  git push --follow-tags

  echo "========================================================="
  echo "Success! cfnless@$NEXT_VERSION published as latest."
  echo "========================================================="
fi