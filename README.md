# Imposter Game

A real-time multiplayer social deduction browser game where players try to identify the hidden imposter among them.

## About The Game

In each round:

* Most players receive the same secret word
* One random player becomes the Imposter and does not know the word
* Players take turns giving clues without directly revealing the word
* The Imposter must analyze the clues and blend in
* After all clues are revealed, players vote for who they think the Imposter is

If the Imposter is voted out, the players win.
If the Imposter survives until the end, the Imposter wins.

---

## Features

* Real-time multiplayer gameplay
* Room code system
* Turn-based clue revealing
* Voting system
* Random role assignment
* Mobile-friendly interface
* Tropical beach-themed UI
* Live game synchronization using Socket.IO

---

## Tech Stack

Frontend:

* HTML
* CSS
* JavaScript

Backend:

* Node.js
* Express.js
* Socket.IO

---

## Installation

Clone the repository:

```bash
git clone https://github.com/JunaidAhamed06/Imposter-game.git
```

Open the project folder:

```bash
cd Imposter-game
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
node server.js
```

---

## How To Play

1. Create or join a room
2. Wait for players to join
3. Start the game
4. Read your assigned role privately
5. Give clues one by one
6. Analyze other players’ clues
7. Vote for the suspected Imposter
8. Win by identifying the Imposter before it is too late

---

## Future Improvements

* Voice chat
* Custom word packs
* Animated avatars
* Public matchmaking
* Player statistics
* Spectator mode
* Ranked gameplay

---

## Author

Created by JunaidAhamed06

GitHub:
https://github.com/JunaidAhamed06
