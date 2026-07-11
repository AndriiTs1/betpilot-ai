# BetPilot AI

# Project Architecture

Version: 1.0

---

# 1. Product Vision

BetPilot AI is an AI-powered WhatsApp betting assistant platform.

The system helps operators manage sports betting operations through:

- WhatsApp communication
- AI bet recognition
- Automated bet processing
- Balance management
- Player management
- Odds verification
- Analytics

---

# 2. Main Goal

Create a professional betting operation management system.

The platform should:

- Receive bets from players via WhatsApp
- Analyze text and screenshots using AI
- Extract betting information
- Request operator confirmation
- Store bets
- Manage USDC balances
- Track player history
- Provide analytics

---

# 3. System Architecture

                    Players

                       |

                       v


              WhatsApp Business API

                       |

                       v


                BetPilot AI Backend

                       |

        --------------------------------

        |              |               |

        v              v               v


      AI Engine    Betting Core    Balance Engine


        |              |               |

        --------------------------------

                       |

                       v


                 PostgreSQL


                       |

                       v


              Operator Dashboard

---

# 4. Applications

## Dashboard

Technology:

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui

Purpose:

Operator control panel.

Functions:

- View bets
- Confirm/reject bets
- Manage players
- View balances
- Analytics
- Settings

---

## Backend API

Technology:

- NestJS
- TypeScript

Purpose:

Main business logic.

Functions:

- WhatsApp webhooks
- AI processing
- Bet validation
- Balance calculations
- Notifications

---

# 5. Core Modules

## 5.1 WhatsApp Module

Responsibilities:

- Receive messages
- Receive images
- Send replies
- Track conversations

Flow:

Player message

↓

WhatsApp API

↓

Webhook

↓

Backend

---

## 5.2 AI Recognition Module

Input:

Text:

"Real Madrid 100 USDC 2.10"

Image:

Betting slip screenshot

Output:

```json
{
  "sport": "FOOTBALL",
  "event": "Real Madrid vs Barcelona",
  "selection": "Real Madrid Win",
  "stake": 100,
  "currency": "USDC",
  "odds": 2.1
}
```

5.3 Betting Engine

Responsible for:

Creating bets
Validating bets
Changing status
Calculating results

Bet lifecycle:

RECEIVED

↓

AI_ANALYZED

↓

WAITING_CONFIRMATION

↓

CONFIRMED

↓

SETTLED

↓

PAID

5.4 Balance Engine

Currency:

USDC

Tracks:

Deposits
Bets
Wins
Losses
Withdrawals 6. Database Entities

Main entities:

User

Player

Bet

Transaction

Wallet

Message

OddsSnapshot

7. Dashboard Pages
   Overview

Statistics:

Active players
Pending bets
Volume
Profit/Loss
Bets
All bets
Filters
Confirmation
Players
Profiles
Balance
History
Transactions
Deposits
Bets
Wins
Withdrawals
Analytics
Reports
Charts
Performance
Settings
WhatsApp
AI
Odds providers
Security 8. Development Phases
Phase 1

Foundation

Project structure
Types
UI architecture
Database design
Phase 2

Dashboard MVP

Bets page
Players page
Transactions page
Phase 3

Backend

NestJS
Database
API
Phase 4

WhatsApp Integration

Business API
Webhooks
Messages
Phase 5

AI Integration

OCR
Image analysis
Bet extraction
Phase 6

Advanced Features

Odds verification
Analytics
Automation
Multi operator support 9. Development Rules
Build only after architecture approval.
Avoid unnecessary code.
Every module must have a clear responsibility.
Keep TypeScript strict.
Build MVP before advanced features.
Project Status

Current phase:

Phase 1 - Foundation

Completed:

[x] Next.js project created

[x] Basic structure created

[x] Product documentation created

Next:

Database and domain modeling
