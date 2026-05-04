# PropFirm Trade Watcher - Build Guide

## 📦 Building the Portable Executable

This guide explains how to build the file watcher desktop app into a portable `.exe` file.

## 🔧 Prerequisites

1. **Node.js** (v16 or higher)
2. **npm** or **yarn**
3. **Windows development environment** (for Windows builds)

## 🚀 Build Instructions

### Step 1: Install Dependencies

```bash
cd watcher-app
npm install
```

### Step 2: Build TypeScript

```bash
npm run build
```

This compiles TypeScript files to the `dist/` directory.

### Step 3: Create Portable Executable

```bash
npm run dist
```

This creates:
- `dist-electron/PropFirmTradeWatcher.exe` - Portable executable
- Installation files (if configured)

### Step 4: Test the Executable

```bash
# Navigate to the output directory
cd dist-electron

# Run the portable executable
./PropFirmTradeWatcher.exe
```

## 📁 Project Structure

```
watcher-app/
├── src/
│   ├── main.ts              # Main Electron process
│   ├── fileWatcher.ts       # File monitoring logic
│   ├── apiClient.ts         # Web app communication
│   ├── logger.ts            # Logging system
│   └── preload.ts           # Renderer process bridge
├── assets/
│   ├── index.html           # Main UI
│   ├── icon.ico             # App icon
│   └── tray-icon.png        # System tray icon
├── dist/                    # Compiled TypeScript
├── dist-electron/           # Built executables
├── package.json             # Dependencies and scripts
└── tsconfig.json            # TypeScript config
```

## ⚙️ Build Configuration

The build is configured in `package.json` under the `build` section:

```json
{
  "build": {
    "appId": "com.propfirm.trade-watcher",
    "productName": "PropFirm Trade Watcher",
    "directories": {
      "output": "dist-electron"
    },
    "win": {
      "target": [
        {
          "target": "portable",
          "arch": ["x64"]
        }
      ],
      "icon": "assets/icon.ico"
    },
    "portable": {
      "artifactName": "PropFirmTradeWatcher.exe"
    }
  }
}
```

## 🔨 Available Scripts

```bash
# Development with hot reload
npm run dev

# Build TypeScript only
npm run build

# Run built version
npm start

# Create portable executable
npm run dist

# Package only (without building)
npm run pack

# Clean build artifacts
npm run clean
```

## 🎯 Build Targets

### Portable Executable (Recommended)
- **Output**: Single `.exe` file
- **Size**: ~15-20MB
- **Installation**: Not required
- **Registry**: No registry entries
- **Permissions**: Standard user permissions

### NSIS Installer (Optional)
```json
{
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

## 📋 Features Included

### Core Functionality
- ✅ File system monitoring (chokidar)
- ✅ CSV parsing and validation
- ✅ HTTP API communication (axios)
- ✅ System tray integration
- ✅ Settings persistence (electron-store)
- ✅ Desktop notifications
- ✅ Auto-start with Windows
- ✅ Comprehensive logging

### User Interface
- ✅ Modern web-based UI (HTML/CSS/JS)
- ✅ Configuration management
- ✅ Real-time status display
- ✅ Log viewing
- ✅ Statistics tracking

### Security Features
- ✅ API key authentication
- ✅ Input validation
- ✅ Error handling
- ✅ Secure settings storage

## 🐛 Troubleshooting Build Issues

### Common Problems

#### 1. Node Modules Not Found
```bash
rm -rf node_modules package-lock.json
npm install
```

#### 2. TypeScript Compilation Errors
```bash
npm run clean
npm run build
```

#### 3. Electron Builder Fails
```bash
# Clear electron-builder cache
npx electron-builder install-app-deps
npm run dist
```

#### 4. Missing Native Dependencies
```bash
# Rebuild native modules for Electron
npx electron-rebuild
```

### Build Environment Issues

#### Windows Specific
- Ensure Windows SDK is installed
- Use Visual Studio Build Tools if needed
- Run as Administrator if file access issues

#### Path Length Issues
- Keep project path short (< 100 characters)
- Use PowerShell instead of Command Prompt

## 📦 Distribution

### File Checklist
- [ ] `PropFirmTradeWatcher.exe` (15-20MB)
- [ ] `MT4_TradeExporter.mq4` (EA source)
- [ ] `MT4_EA_Installation_Guide.md`
- [ ] `README_Automated_Import_System.md`

### Distribution Package Structure
```
PropFirm-Automated-Import-v1.0/
├── PropFirmTradeWatcher.exe        # Portable watcher app
├── MT4_TradeExporter.mq4           # MT4 Expert Advisor
├── MT4_EA_Installation_Guide.md    # EA setup guide
├── README_Automated_Import_System.md # Complete documentation
└── CHANGELOG.md                    # Version history
```

## 🔄 Version Management

### Updating Version
1. Update `package.json` version
2. Update `README.md` references
3. Rebuild executable
4. Test thoroughly before distribution

### Changelog Format
```markdown
## [1.0.0] - 2025-09-11
### Added
- Initial release
- File watching functionality
- API integration
- System tray integration

### Fixed
- File parsing edge cases
- Connection timeout handling
```

## 🧪 Testing

### Manual Testing Checklist
- [ ] App starts without errors
- [ ] System tray icon appears
- [ ] Settings can be saved/loaded
- [ ] File monitoring works
- [ ] API connection successful
- [ ] CSV parsing accurate
- [ ] Error handling graceful
- [ ] Logging functional

### Automated Testing
```bash
# Run tests (if implemented)
npm test

# Lint code
npm run lint
```

## 📊 Build Metrics

### Typical Build Times
- **TypeScript Compilation**: 10-15 seconds
- **Electron Packaging**: 30-45 seconds
- **Total Build Time**: 1-2 minutes

### Output Sizes
- **Portable .exe**: 15-20MB
- **Installer**: 20-25MB
- **Unpacked**: 60-80MB

---

## 🚀 Quick Build Commands

```bash
# Full build from scratch
npm run clean && npm install && npm run build && npm run dist

# Development build
npm run dev

# Production build only
npm run build && npm run dist
```

**Result**: `dist-electron/PropFirmTradeWatcher.exe` - Ready for distribution!

---

*Build Guide v1.0 | Compatible with Node.js 16+ | Windows 10/11*