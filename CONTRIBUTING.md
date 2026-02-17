# Contributing to Trimly

Thank you for your interest in contributing to Trimly! This extension helps keep ChatGPT fast by optimizing DOM performance.

## Getting Started

### Prerequisites

- Node.js 24.10.0+ (use [fnm](https://github.com/Schniz/fnm) or check [.node-version](./.node-version)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/fr0st-xyz/trimly.git
cd trimly

# Install dependencies
npm install

# Firefox
npm run build:firefox
# Open: about:debugging#/runtime/this-firefox
# Click: Load Temporary Add-on
# Select: trimly/extension/manifest.json

# ------------------------------------

# Chrome
npm run build:chrome
# Open chrome://extensions
# Enable Developer mode
# Click Load unpacked
# Select: trimly/extension

# ------------------------------------

# All
npm run build

```

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/fr0st-xyz/trimly/issues) first
2. Create a new issue with:
   - Firefox version
   - Extension version
   - Steps to reproduce
   - Expected vs actual behavior

### Suggesting Features

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Submitting Code

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run checks:
   ```bash
   npm run lint
   npm run build:types
   npm run build
   ```
5. Commit with a clear message
6. Push and open a Pull Request
