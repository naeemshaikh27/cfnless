#!/bin/bash

# Exit on error
set -e

echo "Building the project..."
npm run build

echo "Linking the package globally..."
npm link --force

echo "Verifying installation..."
cfnless --version

echo "Link successful. You can now use 'cfnless' globally."
echo "---------------------------------------------------------"

if [ ! -f "cfnless.yml" ] && [ ! -f "serverless.yml" ]; then
  echo "No local test configuration found (cfnless.yml or serverless.yml)."
  echo "To run a full local test against AWS, please create one first."
  echo "For example: cp examples/cfnless.yml cfnless.yml"
  echo "Then run this script again."
  exit 0
fi

run_cmd() {
  local label="$1"
  shift
  echo "Running: $label"
  echo "---------------------------------------------------------"
  set +e
  "$@"
  EXIT_CODE=$?
  set -e
  if [ $EXIT_CODE -ne 0 ]; then
    echo "---------------------------------------------------------"
    echo "'$label' failed! If this is an authentication error, ensure your AWS credentials are set:"
    echo "  export AWS_PROFILE=my-profile"
    echo "  # OR"
    echo "  export AWS_ACCESS_KEY_ID=your_key"
    echo "  export AWS_SECRET_ACCESS_KEY=your_secret"
    echo "  export AWS_REGION=us-east-1"
    echo "Then try running 'npm run local:remove' again."
    exit $EXIT_CODE
  fi
  echo "---------------------------------------------------------"
}

run_cmd "cfnless remove" cfnless remove

echo "Local remove ran successfully!"
