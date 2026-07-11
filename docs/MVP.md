## MVP Scope

The first version focuses on operator workflow.

The operator receives bets from players via WhatsApp,
reviews AI analysis and confirms or rejects bets.

The first MVP does not include:

- automatic odds verification
- automatic settlement
- player mobile application
- multi-operator support

These features will be added in future versions.

## Product Vision

BetPilot AI is an AI-powered WhatsApp betting assistant.

The system receives betting requests from players, analyzes them, asks for confirmation, stores bets and manages balances.

---

# Main Flow

Player
↓
WhatsApp Business
↓
BetPilot AI
↓
AI Analysis
↓
Admin Confirmation
↓
Bet Saved
↓
Balance Updated

---

# MVP Features

## 1. WhatsApp Integration

Receive:

- Text messages
- Betting screenshots
- Betting slips

Example:

Real Madrid
100 USDC
Odds 2.10

---

## 2. AI Bet Recognition

AI extracts:

- Sport
- Event
- Selection
- Odds
- Stake
- Currency

---

## 3. Confirmation System

Before accepting:

Admin sees:

Event:
Real Madrid - Barcelona

Selection:
Real Madrid Win

Stake:
100 USDC

Odds:
2.10

Actions:

Confirm
Reject

---

## 4. Bet Management

Store:

- Player
- Event
- Stake
- Odds
- Status
- Date

---

## 5. Balance Management

Track:

- Deposits
- Bets
- Wins
- Losses
- Current balance

Currency:

USDC

---

# Future Features

## Odds Verification

Compare received odds with external providers.

## Automatic Settlement

Calculate results after matches.

## Player Dashboard

Players can view:

- Balance
- Bets
- History

---

# Technology Stack

Frontend:

Next.js
TypeScript
Tailwind CSS

Backend:

NestJS
TypeScript

Database:

PostgreSQL

AI:

OCR + LLM

Messaging:

WhatsApp Business API
