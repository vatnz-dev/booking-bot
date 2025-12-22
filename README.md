# VATNZ ATC Booking Bot

This repository contains the **VATNZ ATC Booking Bot** project. It is designed to streamline controller scheduling, mentoring workflows, and operational coordination across VATNZ. The bot integrates with Discord and provides a structured booking system for ATC sessions.

---

## Features

- **Controller Scheduling**: Book ATC positions directly via Discord  
- **Mentoring Support**: Enforces endorsement policies and mentoring workflows  
- **Operational Transparency**: Improves visibility of controller availability and bookings  
- **Scalable Design**: Built with Node.js and Discord.js v14, with planned MongoDB integration  
- **Event Management**: Supports VATNZ events and division-wide coordination  
- **VATSIM Integration**: Integration with the VATSIM Bookings API *(Work in progress)*  

---

## Tech Stack

- **Node.js** – Backend runtime  
- **Discord.js v14** – Discord bot framework  
- **dotenv** – For environment variables  

---

## Requirements

Before running the bot, ensure you have the following installed:

- **Latest version of Node.js**  
  Download from [https://nodejs.org](https://nodejs.org)  
- **npm** (comes bundled with Node.js)

---

## Environment Variables

Create a `.env` file in the root of the project (same folder as `index.js`) with the following content:

```env
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_channel_id_here  
```

- `DISCORD_TOKEN` → The bot token from Discord Developer Portal  
- `CHANNEL_ID` → The ID of the channel where the bot will post messages  

> **Important:** Never commit your `.env` file to GitHub or share it publicly.

---

## Installation

1. Clone or download this repository.  
2. Open **Command Prompt (CMD)** or a terminal.  
3. Navigate to the project folder (the folder containing `index.js` and `package.json`):

```bash
cd path/to/your/bot-folder
```
4. Install the required packages:

```bash
npm install
```
This will install all dependencies listed in `package.json`.

---

## Launching the Bot

1. Make sure you are in the folder containing:
   - `index.js`
   - `package.json`
   - `.env`

2. Start the bot by running:

```bash
npm start
```
If configured correctly, the bot will connect to Discord and begin running.
---

---

## Notes

- Ensure your **bot token and channel ID** are correctly set in the `.env` file.  
- Keep **Node.js up to date** to maintain compatibility with Discord.js.  
- The CMD or terminal window must remain open while the bot is running.  
- Never share your `.env` file or bot token publicly.  
- If you make changes to `package.json` or install new packages, run `npm install` again before starting the bot.





