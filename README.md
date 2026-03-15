# SunoForge 🎼

**AI-Powered Song Lyric Generator & Composer Assistant**

SunoForge is a comprehensive song creation tool that uses Google's Gemini AI to generate professional-quality lyrics, suggest chord progressions, and provide detailed production guidance. Designed for use with Suno AI or other music creation platforms.

---

## ✨ Key Features

### Two Main Workflows

**1. 🎨 Generate from Scratch**

- Start with just an idea, concept, or title
- AI generates complete lyrics, style prompts, and chord progressions
- Full control over genre, mood, structure, vocals, and production
- Perfect for: New song ideas, creative exploration, complete AI-assisted composition

**2. 🔄 Analyze & Import**

- Import existing lyrics or style descriptions from Suno (or anywhere)
- AI analyzes and auto-configures all settings
- Refine, complete, or rewrite existing material
- Perfect for: Enhancing Suno outputs, analyzing existing songs, style matching

### At a Minimum, You Need

- **Just an idea** - Enter a song title or concept and let AI handle everything else
- **Or import lyrics/style** - Paste existing content to analyze and enhance

### What You Get

- ✅ Complete song lyrics with professional structure
- ✅ Suno-compatible style prompts (genre, mood, era, production)
- ✅ Suggested chord progressions by section
- ✅ Export-ready format for immediate use in Suno
- ✅ Full creative control with granular options

---

## 🚀 Getting Started

### Prerequisites

- A Google AI Studio API key ([Get one here](https://aistudio.google.com/app/apikey))
- A modern web browser
- No installation required - runs entirely in your browser

### Setup

1. [Open SunoForge](https://ratava.github.io/SunoForge/index.html) in your browser
2. Enter your Google AI Studio API key in the top bar
3. Click **Save**
4. Status indicator should change to **✓ ready**

> **Note:** Your API key is stored locally in your browser's localStorage (unencrypted). Only use on trusted devices.

---

## 🎵 Quick Start

### Basic Workflow

1. **Configure** your song using the left panel tabs
2. **Click "Write My Song"** to generate lyrics
3. **Review** the output in the right panel
4. **Export** your song for use in Suno or other platforms

### Recommended First Steps

1. **Settings Tab:** Enter a song title and concept
2. **Structure Tab:** Choose a genre-appropriate structure
3. **Click Generate:** Let the AI handle the rest
4. **Fine-tune:** Adjust Vocal, Sound, and other options for more control

---

## 📋 Left Panel Tabs

### ⚙️ Settings

Core song configuration and musical fundamentals.

- **Song Title** - Name your track
- **Concept/Story** - What the song is about (narrative, theme, emotion)
- **Genre** - Select from Rock, Metal, Folk, Country, Jazz, Blues, R&B, Hip-Hop, Gospel, Reggae, Ska, Latin, Cumbia, or create custom
- **Mood** - Emotional tone (Raw & Defiant, Melancholic, Anthemic, Dark & Brooding, etc.)
- **Rhyme Scheme** - Choose from AABB, ABAB, ABCB, AABA, Free Verse, Multisyllabic, or let AI decide
- **Tempo** - AI Choose, Slow, Medium, Fast, or set custom BPM range
- **Song Duration** - AI Choose, Short (~~2 min), Medium (~~3.5 min), Long (~5+ min), or custom
- **Musical Key** - Select key signature or let AI choose
- **Time Signature** - 4/4, 3/4, 6/8, 5/4, 7/8, or custom
- **Perspective** - 1st person, 2nd person, 3rd person, or shifting POV
- **Verse Length** - AI Choose, Short (2 lines), Standard (4 lines), Extended (6+ lines)
- **Chorus Length** - AI Choose, Concise (2 lines), Standard (4 lines), Extended (6+ lines)

### 🎤 Vocal

Define vocal characteristics and arrangements.

- **Lead Vocal Type**
  - Single Male
  - Single Female
  - Male Duo
  - Female Duo
  - Male & Female Duo
  - Instrumental (no vocals)
- **Vocal Profiles** (when not Instrumental)
  - **Gender** - Male, Female, Non-Binary, or AI Choose
  - **Age** - Young, Middle-Aged, Older, Timeless, or AI Choose
  - **Range** - Low, Mid, High, Wide, or AI Choose
  - **Tone** - Rough, Smooth, Breathy, Powerful, Soulful, Raspy, Clear, or AI Choose
  - **Style** - Crooning, Belting, Spoken-Word, Rap Flow, Vibrato-Heavy, Straight Tone, or AI Choose
- **Choir/Backing Vocals** (optional)
  - Enable to add choir or backing vocals
  - Configure gender, size (small/large ensemble), and when they appear (chorus, bridge, throughout)

### 🎵 Structure

Choose or build your song's structural blueprint.

- **Custom Structure Builder**
  - Build completely custom song structures from scratch
  - Choose from pre-defined blocks (Intro, Verse, Chorus, Bridge, Solo, etc.)
  - Add custom blocks for unique sections
  - Append chord progressions and performance notes to each section
  - Save and reuse custom structures
- **Genre-Specific Presets**
  - Each genre includes multiple authentic structure templates
  - Examples: "Standard Rock", "12-Bar Blues", "AABA Jazz", "Trap Anthem", "Bolero Form"
  - Structures update automatically when you change genres
  - Includes flow diagram and description for each preset

### 🔊 Sound

Shape the production aesthetic and sonic character.

- **Era/Decade** - 1950s through 2020s, Timeless, or custom period
- **Production Style** - Lo-Fi, Hi-Fi, Vintage, Modern, Live, Bedroom, Studio Polished, etc.
- **Instrumentation Focus**
  - Acoustic, Full Band, Electronic, Strings-Led, Horns Section
  - Solo + Voice, Heavy Guitar, Rhythm-Led, Hybrid Organic
  - Add custom instrumentation descriptions
- **Instrument Exclusions** - Comma-separated list of instruments to avoid
- **Mix Character**
  - Warm Analog, Crisp Digital, Heavy Compression, Dynamic & Open
  - Deep Low-End, Bright & Airy, Mid-Forward
  - Wet/Reverb-Heavy, Dry & Intimate
  - Add custom mix descriptions
- **Suggest Influences** (optional)
  - Add artist/band influences (must be Suno-compatible)
  - AI will incorporate stylistic elements into the generation
  - Quick-add suggestions provided

### ✍️ Lyrics

Provide your own lyrics for AI to work with.

- **AI Mode** - What should the AI do with your lyrics?
  - **Complete the song** - Finish partial lyrics
  - **Rewrite/improve** - Enhance existing lyrics
  - **Match my style** - Generate new lyrics in your style
  - **Fit to structure** - Adapt lyrics to chosen structure
  - **Keep my current lyrics** - Use as-is with minimal changes
- **Your Lyrics** - Paste or type lyrics with optional section labels:

  ```text
  [Verse]
  Your verse here...

  [Chorus]
  Your chorus...
  ```

---

## 📊 Right Panel Tabs

### Output

Displays your generated song with interactive controls.

- **Song metadata** - Title, genre, tempo, key, structure
- **Full lyrics** - Organized by section with meta tags
- **Section controls**
  - **Regenerate individual sections** - Click section header to regenerate just that part
  - View chord progressions per section
  - Copy individual sections
- **Action buttons**
  - **Copy Lyrics** - Copy all lyrics to clipboard
  - **Export** - Open full export modal
  - **Save to History** - Preserve this version

### Chords

View suggested chord progressions for your song.

- Displays chords organized by section
- Roman numeral notation with chord names
- Updates automatically with each generation

### History

Manage saved songs and project versions.

- **Saved Songs List** - All previously saved songs with metadata
- **Load** - Click any saved song to restore it
- **Delete** - Remove individual songs
- **Import** - Load songs from exported .txt files
- **Export** - Save individual songs to .txt
- **Clear All** - Remove all saved history

---

## 🔧 Key Features

### 🔍 Analyze Button

Auto-configure settings from lyrics or style descriptions.

**Use cases:**

- Paste existing lyrics to detect structure, mood, genre, tempo
- Describe desired sound ("early Tom Waits meets Nick Cave, dark cabaret")
- Combine both lyrics and style description

**What it does:**

- Extracts song structure from labeled sections
- Auto-sets Genre, Mood, Tempo, Era, Production, Instrumentation, Mix
- Suggests influences based on style description
- Updates settings across all tabs

**How to use:**

1. Click **Analyze** button
2. Enter lyrics, style description, or both
3. Click **Analyze** in the modal
4. Review auto-configured settings
5. Make any manual adjustments
6. Generate your song

### 📤 Export Modal

Comprehensive export options for your generated song.

Includes:

- **Song Title** - Copy separately for Suno's title field
- **Style Prompt** - Complete style/genre description
- **Lyrics** - Formatted lyrics with meta tags stripped for clean Suno input
- **Exclusions** (if any) - Instruments to exclude
- **Download .txt** - Save complete song file with all metadata

**Export Format:**

```text
Title: [Your Song Title]
Style: [Complete style prompt with genre, mood, era, production notes]

[Verse 1]
Your lyrics here...

[Chorus]
Your chorus...
```

### 🐛 Debug Mode

Advanced troubleshooting and logging.

**Enable:** Double-click the SunoForge logo

**Features:**

- Real-time logging of all operations
- Categorized logs (SYSTEM, STATE, TAB_CHANGE, ANALYZER, SONG_GENERATION, etc.)
- Timestamped entries
- **Download Debug Logs** - Click the debug indicator to export full session log with:
  - Version info
  - All logged events
  - Current song export
  - Timestamps and metadata

**Use when:**

- Troubleshooting generation issues
- Reporting bugs
- Understanding AI behavior
- Tracking section regeneration

---

## 💡 Tips & Best Practices

### For Best Results

1. **Start Simple**

- Begin with just Title and Concept
- Let AI handle Genre, Mood, and Structure
- Fine-tune after seeing initial results

1. **Use the Analyzer**

- Paste reference lyrics to quickly configure settings
- Describe your ideal sound in natural language
- Combines well with manual tweaking

1. **Structure Matters**

- Genre-specific structures are optimized for that style
- Custom structures give you complete control
- Add chord progressions and notes for precision

1. **Iterate Sections**

- Don't regenerate the whole song if only one section isn't working
- Click section headers to regenerate individual parts
- Preserves the rest of your song

1. **Save Frequently**

- Use History tab to save versions
- Export to .txt files for backup
- Can import previously exported songs

1. **Vocal Configuration**

- For specific vocal styles, configure Vocal tab details
- Leave fields as "AI Choose" for automatic selection
- Instrumental mode provides performance directions instead of lyrics

1. **Sound Layering**

- Combine multiple options in Sound tab
- Mix Character + Era + Production Style = rich sonic palette
- Use Influences sparingly (1-3 artists max)

### Common Workflows

**Workflow 1: Quick Generation**

1. Settings: Enter title and concept
2. Click "Write My Song"
3. Export to Suno

**Workflow 2: Style-Based**

1. Click Analyze
2. Describe desired sound
3. Review auto-configured settings
4. Generate

**Workflow 3: Lyrics-First**

1. Lyrics tab: Paste your lyrics
2. Choose AI mode (complete/rewrite/match/fit)
3. Optionally use Analyzer to extract structure
4. Generate

**Workflow 4: Precision Control**

1. Configure all tabs (Settings, Vocal, Structure, Sound)
2. Build custom structure if needed
3. Add specific influences and exclusions
4. Generate with full control

---

## 🔒 Privacy & Security

- **API Key Storage:** Your Google AI Studio API key is stored locally in browser localStorage (not encrypted)
- **Data:** All song data is stored locally in your browser
- **Network:** Only connects to Google's Gemini AI API for generation
- **No Server:** Completely client-side application, no data sent to external servers

**Recommendation:** Only use on trusted personal devices.

---

## 📝 Version

Current Version: **20260315-004** (March 15, 2026)

---

## 🎸 Suno Integration

SunoForge is designed to export songs in Suno-compatible format:

1. Generate your song in SunoForge
2. Click **Export**
3. Use the copy buttons:

- **Copy Song Title** → Paste into Suno's title field
- **Copy Style Prompt** → Paste into Suno's style field
- **Copy Lyrics** → Paste into Suno's lyrics field

1. Create your track in Suno

---

## ❓ FAQ

**Q: Do I need an internet connection?**  
A: Yes, for AI generation only. The app itself runs offline but needs internet to call Google's Gemini AI API.

**Q: What's the difference between Genre presets and custom genre?**  
A: Presets include curated song structures. Custom genres let you define any style but use universal structures.

**Q: Can I save my API key permanently?**  
A: It's saved in your browser's localStorage on the device you're using, but this is not encrypted storage.

**Q: Why isn't my song generating?**  
A: Check that:

- API key is entered and status shows "✓ ready"
- You have internet connection
- You've entered at least a title or concept
- Enable debug mode (double-click logo) to see detailed logs

**Q: Can I use this for commercial music?**  
A: SunoForge generates lyrics/suggestions using AI. Review Google's Gemini AI terms and Suno's terms for commercial usage rights.

**Q: How do I report a bug?**  
A: Submit bug reports via our [GitHub Issues page](https://github.com/ratava/SunoForge/issues). To help us reproduce and fix the problem:

1. Enable debug mode (double-click the logo)
2. Reproduce the issue
3. Download the debug logs (click the debug indicator)
4. Attach the debug file to your issue report

---

## 🎼 Happy Creating

SunoForge is your creative partner in songwriting. Experiment, iterate, and make something amazing.
