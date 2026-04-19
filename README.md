# Spotlight Recorder

A free, open-source Chrome extension that records your screen with beautiful cursor spotlight effects. A free alternative to Cursorful ($79).

![Spotlight Recorder](icons/icon128.png)

## Features

- **Screen Recording**: Record tabs, windows, or your entire screen
- **Cursor Spotlight**: Beautiful glowing cursor effect that follows your mouse
- **Multiple Styles**: Choose from Glow, Ring, or Solid spotlight styles
- **Customizable**: Adjust spotlight size and color
- **One-Click Stop**: Icon changes during recording - click once to stop & save
- **Countdown Timer**: 3-2-1 countdown before recording starts
- **Pause/Resume**: Pause and resume your recordings
- **Export Options**: Save as WebM or MP4
- **Quality Settings**: High (1080p), Medium (720p), or Low (480p)
- **Clean UI**: Minimal, modern interface

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked"
5. Select the extension folder

## Usage

1. Click the Spotlight Recorder icon in your Chrome toolbar
2. Select what to record: Tab, Window, or Screen
3. Customize your spotlight settings (optional)
4. Click "Start Recording"
5. A countdown will appear, then recording begins
6. **One-Click Stop**: The extension icon turns red while recording - just click it once to stop and save!
7. Your video will be downloaded automatically

### One-Click Recording Flow
- **Start**: Open popup → Configure → Click "Start Recording"
- **Stop**: Just click the red extension icon (no popup needed!)
- This eliminates the awkward "opening popup to stop" moment at the end of recordings

## Spotlight Customization

### Colors
- Purple (default)
- Orange
- Green
- Red
- Pink

### Styles
- **Glow**: Soft radial gradient effect
- **Ring**: Circular outline with subtle fill
- **Solid**: Filled circle with gradient

### Size
Adjust from 40px to 150px using the slider

## Settings

Access settings via the gear icon:

- **Countdown**: Enable/disable 3-2-1 countdown
- **Audio**: Record system audio
- **Format**: WebM or MP4
- **Quality**: High, Medium, or Low
- **Watermark**: Optional "Made with Spotlight" watermark

## Technical Details

- Built with Manifest V3
- Uses Chrome's `desktopCapture` and `tabCapture` APIs
- Canvas-based cursor overlay for spotlight effects
- MediaRecorder API for video capture
- Zero dependencies, pure vanilla JavaScript

## File Structure

```
spotlight-recorder/
├── manifest.json          # Extension manifest
├── popup/
│   ├── popup.html        # Popup UI
│   ├── popup.css         # Popup styles
│   └── popup.js          # Popup logic
├── background/
│   └── background.js     # Service worker
├── content/
│   ├── content.js        # Spotlight overlay
│   └── content.css       # Content styles
├── offscreen/
│   ├── offscreen.html    # Offscreen document
│   └── offscreen.js      # Recording logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── scripts/
    └── create-png-icons.js  # Icon generator
```

## Browser Support

- Chrome 116+
- Edge 116+
- Brave (latest)

## Privacy

- All recordings are processed locally
- No data is sent to external servers
- No user accounts required
- No tracking or analytics

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - feel free to use this for personal or commercial projects.

## Author

Made by [Muhammad Anas Khan](https://github.com/muhammedanaskhan)

---

**Like Spotlight Recorder?** Check out my other projects!
