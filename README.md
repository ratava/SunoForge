# SunoForge

![API Key](https://github.com/ratava/SunoForge/blob/main/images/logo.webp?raw=true)

This work is licensed under a [Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/).
[![License: CC BY-NC 4.0](https://licensebuttons.net/l/by-nc/4.0/80x15.png)](https://creativecommons.org/licenses/by-nc/4.0/)

## AI-Powered Song Lyric Generator & Composer Assistant

SunoForge is a comprehensive song creation tool that uses AI to generate professional-quality lyrics, suggest chord progressions, and provide detailed production guidance. Designed for use with Suno AI or other music creation platforms. Supports Google AI Studio (Gemini models) and OpenRouter (hundreds of third-party models) as AI providers.

---

## ✨ Key Features

### Two Main Workflows

#### 1. 🎨 Generate from Scratch

- Start with just an idea, concept, or title
- AI generates complete lyrics, style prompts, and chord progressions
- Full control over genre, mood, structure, vocals, and production
- Perfect for: New song ideas, creative exploration, complete AI-assisted composition

#### 2. 🔄 Analyze & Import

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

- A **Google AI Studio API key** and/or an **OpenRouter API key** (at least one is required)
- A modern web browser
- No installation required — runs entirely in your browser

### API Providers

SunoForge supports two AI providers. You can configure one or both:

| Provider | Cost | Models available |
| --- | --- | --- |
| **Google AI Studio** | Free tier available, cheapest | Gemini models (fetched live from your account) |
| **OpenRouter** | Pay-per-use, more expensive | Hundreds of text models from many providers |

You can have both keys saved simultaneously. The **Model selector** determines which provider is used for each generation — SunoForge routes the request automatically based on which provider the selected model belongs to.

### Setup — Google AI Studio Key

If you need to create an API key ([Get one here](https://aistudio.google.com/app/apikey))

1. Sign in with a Google account
2. Click **Create API Key**
3. Give it a name
4. Assign it to the default project or create a new one
   ![API Key](https://github.com/ratava/SunoForge/blob/main/images/aistudio1.png?raw=true)
5. Make sure billing is enabled on the key/project (Free tier is fine)
    ![API Key](https://github.com/ratava/SunoForge/blob/main/images/aistudio2.png?raw=true)
6. Hit the copy key icon to get your API key

7. [Open SunoForge](https://ratava.github.io/SunoForge/index.html) in your browser
8. Enter your Google AI Studio API key in the **Google AI Studio Key** field in the top bar
9. Click **Save**
10. Status indicator should change to **✓ ready** — the model list will populate with your available Gemini models

   ![API Key](https://github.com/ratava/SunoForge/blob/main/images/apikey.png?raw=true)

### Setup — OpenRouter Key

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Go to **Keys** and create a new API key
3. Add credit to your account (OpenRouter is pay-per-use)
4. In SunoForge, enter your key in the **OpenRouter Key** field
5. Click **Save**
6. Status indicator will show **✓ ready** — the full OpenRouter model catalogue will be fetched and added to the model list

> **Note:** Both API keys are stored locally in your browser's localStorage (unencrypted). Only use on trusted devices.

### Model Selection

The **Model** dropdown in the top bar lets you choose which AI model to use for generation.

- When a Google AI Studio key is saved, all Gemini models available to your account appear at the top of the list
- When an OpenRouter key is saved, all OpenRouter text-generation models are appended below
- The list is **searchable** — type any part of a model name to filter
- Your selection is saved between sessions
- The default model is `gemini-3.1-flash-lite-preview` (Google) — fast and inexpensive
- Models listed with **(Google)** route through Google AI Studio; models listed with **(OpenRouter)** route through OpenRouter

> ⚠ SunoForge is not liable for any costs incurred when using your selected model. Always verify pricing on the provider's website before using a high-cost model.

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
- **Genre** - Select from Rock, Metal, Folk, Country, Jazz, Blues, R&B, Hip-Hop, Gospel, Reggae, Electronic/Dance, Ambient, Lo-Fi/Chill, Classical, Cinematic, World Music, Pop, Christian, or create custom
- **Mood** - Emotional tone (Raw & Defiant, Melancholic, Anthemic, Dark & Brooding, Soulful & Warm, Joyful, Playful & Loose, or custom)
- **Goal** - Song purpose (Background Music, Dance Floor Banger, Meditation, Workout, Focus/Study, Sleep, Party, Cinematic, Gaming, Podcast, TikTok, Emotional, Storytelling, or custom)
- **Rhythm** - Rhythm style (Triplet, Swing, Syncopated, Polyrhythmic, Minimal, Broken, Locked, Groove-Based, or custom)
- **Groove Feel** - Pocket/groove character (Funky, Smooth, Driving, Tight, Loose, Bouncy, Laid-back, Groovy, Hypnotic, or custom)
- **Perspective** - 1st person, 2nd person, 3rd person, or collective (we/us)
- **Rhyme Scheme** - Choose from AABB, ABAB, ABCB, AABA, ABBA, Free Verse, Multisyllabic, Triplet Flow, or custom
- **Tempo** - Auto (let AI choose) or set custom BPM range (e.g., 90-110 BPM)
- **Song Duration** - Auto (let AI choose) or set specific duration (e.g., 3:00 - 4:00)
- **Musical Key** - Select key signature or Auto (let AI choose)
- **Time Signature** - 4/4, 3/4, 2/4, 6/8, 5/4, 7/4, 7/8, 9/8, 12/8, or custom
- **Verse Length** - Follow Structure, 4 Bars, 8 Bars, or 16 Bars
- **Chorus Length** - Follow Structure, 4 Bars, 8 Bars, 16 Bars, or 32 Bars
- **Song Language** - The language the AI writes the **lyrics** in. Choose from:
  - English, German, French, Dutch, Spanish, Portuguese, Russian, Japanese, Korean, Chinese (Mandarin), Chinese (Cantonese), or **Custom** (type any language)
  - This is independent of the UI language — you can use the app in English but generate lyrics in French, for example
  - When a non-English language is selected, the AI prompt explicitly instructs the model not to mix in any English

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

- **Era/Decade** - 1920s-40s through Modern/2020s, Timeless, or custom period
- **Instruments** - Select specific instruments (52 options including guitars, keyboards, strings, brass, woodwinds, percussion, and more, or add custom)
  - Guitars: Acoustic, Nylon, Electric, Classical, Steel, Pedal Steel, Dobro
  - Bass: Bass Guitar, Upright Bass, Synth Bass
  - Keyboards: Pianos (Acoustic, Electric, Concert Grand, Upright), Synthesizers (Moog, Wavetable, Pad, Lead, Bass), Organs (Pipe, Hammond, Electric, Wurlitzer)
  - Strings: String Section/Quartet, Violin, Cello
  - Brass: Brass Section, Trumpet, Trombone, French Horn, Tuba, Horns
  - Woodwinds: Saxophone, Woodwind Section, Clarinet, Oboe, Flute
  - Other: Harp, Ukulele, Mandolin, Banjo, Harmonica, Vibraphone, Marimba
  - Percussion: Drums (Acoustic/Electronic), Timpani, Gong, Cowbell
- **Instrumentation Focus** - General approach
  - Acoustic, Full Band, Electronic, Strings-Led, Horns Section
  - Solo + Voice, Heavy Guitar, Rhythm-Led, Hybrid Organic
  - Add custom instrumentation descriptions
- **Bass** - Bass style and character
  - Deep Sub-Bass, 808 Bass, Warm Bass, Punchy Bass, Clean Bass, Fuzzy Bass
  - Melodic Bass, Minimal Bass, Prominent Bass, Subtle Bass, Filtered Bass
  - Synth Bass, Acoustic Bass, Fretless Bass, or custom
- **Spatial/Effects** - Effects and spatial processing (multi-select)
  - Spatial: Reverb-Heavy, Delay Effects, Wide Stereo, Dolby Atmos, Panning, Echo
  - Modulation: Chorus, Flanger, Phaser, Light/Medium/Heavy Modulation
  - Distortion levels: None, Light, Medium, Heavy
  - Compression levels: None, Light, Medium, Heavy
  - Add custom effects
- **Instrument Exclusions** - Comma-separated list of instruments to avoid
- **Production Style** - Raw & Live, Polished Studio, Lo-Fi, Cinematic, Minimalist, Experimental, Live/Arena, Bedroom/DIY, Club Ready, or custom
- **Mix Character** (multi-select)
  - Character: Warm Analog, Crisp Digital, Heavy Compression, Dynamic & Open
  - Frequency: Deep Low-End, Bright & Airy, Mid-Forward
  - Space: Wet/Reverb-Heavy, Dry & Intimate
  - Balance: Loud and Punchy, Balanced, Vocal-Forward, Vocal-Balanced, Instrumental-Focused
  - Mastering: Warm-Mastering, Bright-Mastering, Dark-Mastering
  - Optimization: Headphone-Optimized, Mono-Compatible
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
  - **Match my style** - Generate completely new lyrics matching the voice/style of your examples
  - **Fit to structure** - Reorganize and adapt existing lyrics to match the chosen song structure
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
  - **↻ Regen** - Regenerate individual sections with AI (preserves other sections)
  - **✎ Edit** - Manually edit section lyrics, type, and direction tags
  - View chord progressions per section
  - Copy individual sections
- **↑ Update Settings** button — appears at the top of the output card. Reads all settings that the AI used or generated (genre, mood, tempo, key, structure, vocal type, sound profile, influences, etc.) and writes them back to every field in the left-panel form. Shows a full preview of what will change and asks for confirmation before applying. Useful for keeping your form in sync with the settings the AI actually used, so the next generation starts from the same baseline.
- **Action buttons**
  - **⤴ Copy to Lyrics Tab** - Send generated lyrics back to Lyrics tab for refinement
  - **Copy All** - Copy all lyrics to clipboard
  - **Export** - Open full export modal
  - **Save to History** - Preserve this version

### Chords

View suggested chord progressions for your song.

- Displays chords organized by section
- Roman numeral notation with chord names
- Updates automatically with each generation

### History

Manage saved songs and project versions.

- **Saved Songs List** - All previously saved songs with title, genre, and save timestamp
- **Load** - Restores a saved song: reloads all settings into the form and re-renders the output, chords, and lyrics tabs
- **Export** - Save an individual song to a `.txt` file
- **Delete** (✗) - Remove a song from history
- **Backup** - Exports **all** songs in history to a single `.txt` backup file. A confirmation modal shows the song count and offers an optional **Include API Key in backup** checkbox (covers both Google AI Studio and OpenRouter keys). If checked, the key is stored in plain text — keep the file in a secure location.
- **Import** - Accepts two file types:
  - **Single-song `.txt`** — a file exported via the per-song Export button. Adds it to history and loads it immediately.
  - **History backup `.txt`** — a file created with the Backup button. Songs are **merged** into the existing history (duplicates resolved by keeping the most recently saved version). If the backup included API keys or a selected model, those are also restored automatically.
- **Clear All** - Remove all saved history after confirmation

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
- Auto-sets Genre, Mood, Goal, Rhythm, Groove Feel, Tempo, Era, Production, Instruments, Instrumentation, Bass, Spatial/Effects, Mix
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

   - Combine multiple options in Sound tab for rich sonic palette
   - Use **Instruments** for specific instrument selection (e.g., "Moog Synthesizer, Fretless Bass, Timpani")
   - Use **Instrumentation Focus** for general approach (e.g., "Acoustic", "Electronic")
   - **Bass** controls bass character independently
   - **Spatial/Effects** lets you specify multiple effects at once
   - Mix Character supports multiple selections for nuanced production
   - Use Influences sparingly (1-3 artists max)

1. **Granular Control**

   - **Goal** and **Groove Feel** help AI understand the song's purpose and pocket
   - **Rhythm** styles (Triplet, Swing, Syncopated) influence lyric phrasing and flow
   - Leave settings unselected (or "AI Choose") to let AI decide based on genre/mood
   - Custom inputs available for most options when you need something specific

### Common Workflows

#### Workflow 1: Quick Generation

1. Settings: Enter title and concept
2. Click "Write My Song"
3. Export to Suno

#### Workflow 2: Style-Based

1. Click Analyze
2. Describe desired sound
3. Review auto-configured settings
4. Generate

#### Workflow 3: Lyrics-First

1. Lyrics tab: Paste your lyrics
2. Choose AI mode (complete/rewrite/match/fit)
3. Optionally use Analyzer to extract structure
4. Generate

#### Workflow 4: Precision Control

1. Configure all tabs (Settings, Vocal, Structure, Sound)
2. Build custom structure if needed
3. Add specific influences and exclusions
4. Generate with full control

---

## 🌐 Interface Language

The SunoForge UI is fully translated into **11 languages**, selectable via the flag dropdown in the top-right corner of the header.

| Flag | Language |
| --- | --- |
| 🇬🇧 English | Default |
| 🇩🇪 Deutsch | German |
| 🇫🇷 Français | French |
| 🇳🇱 Nederlands | Dutch |
| 🇪🇸 Español | Spanish |
| 🇵🇹 Português | Portuguese |
| 🇷🇺 Русский | Russian |
| 🇯🇵 日本語 | Japanese |
| 🇰🇷 한국어 | Korean |
| 🇨🇳 简体中文 | Simplified Chinese |
| 🇨🇳 繁體中文 | Traditional Chinese |

Switching language updates all labels, buttons, placeholders, and status messages instantly. Your preference is saved between sessions.

> **Note:** The UI language is independent of the **Song Language** setting. Changing the UI language does not affect the language the AI writes lyrics in.

---

## 🔒 Privacy & Security

- **API Key Storage:** Your Google AI Studio and OpenRouter API keys are stored locally in browser localStorage (not encrypted)
- **Data:** All song data is stored locally in your browser
- **Network:** Only connects to Google's Gemini AI API or OpenRouter's API for generation, depending on the selected model
- **No Server:** Completely client-side application — no data is sent to any SunoForge servers

**Recommendation:** Only use on trusted personal devices. Do not share exported backup files that include your API key.

---

## 📝 Version

Current Version: **20260319-001** (March 19, 2026)

---

## 🎸 Suno Integration

SunoForge is designed to export songs in Suno-compatible format:

1. Generate your song in SunoForge
2. Click **Export**
3. Use the copy buttons:

   - **Copy Song Title** → Paste into Suno's title field
   - **Copy Style Prompt** → Paste into Suno's style field
   - **Copy Lyrics** → Paste into Suno's lyrics field

4. Create your track in Suno

---

## ❓ FAQ

**Q: Do I need an internet connection?**  
A: Yes, for AI generation only. The app itself runs offline but needs internet to call the Google AI or OpenRouter API.

**Q: Do I need both a Google AI Studio key and an OpenRouter key?**  
A: No — you only need one. Google AI Studio is recommended as a starting point because it has a free tier. OpenRouter is useful if you want to experiment with other models (Claude, Llama, Mistral, etc.). You can add both at any time and switch between them via the Model selector.

**Q: Which model should I use?**  
A: The default `gemini-3.1-flash-lite-preview` is fast and costs very little. For better quality at slightly higher cost, try a full `gemini-flash` or `gemini-pro` model. If using OpenRouter, any instruction-following text model works — look for models with large context windows (32k+) for best results with long lyrics.

**Q: Can I write lyrics in a language other than English?**  
A: Yes. Use the **Song Language** dropdown in the Settings tab to select the language for the lyrics. The AI will write all lyrics exclusively in that language. This is independent of the UI language — the app interface and the song lyrics can be in different languages.

**Q: What's the difference between Genre presets and custom genre?**  
A: Presets include curated song structures. Custom genres let you define any style but use universal structures.

**Q: What's the difference between Instruments and Instrumentation Focus?**  
A: **Instruments** lets you select specific instruments (e.g., "Moog Synthesizer", "Fretless Bass", "Timpani"). **Instrumentation Focus** describes the general approach (e.g., "Acoustic", "Full Band", "Electronic"). Use both together for precise control, or just one for more general direction.

**Q: Should I fill out all the settings?**  
A: No! You can be as specific or as loose as you want. At minimum, just provide a title/concept. Leave settings unselected or set to "AI Choose" to let the AI decide based on your genre and mood. The more you specify, the more control you have.

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
