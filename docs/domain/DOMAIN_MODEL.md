# BetPilot AI

# Domain Model

Version: 1.0

---

# Core Entities

The system consists of the following main entities:

- Operator
- Player
- Bet
- Transaction
- Wallet
- Message
- OddsSnapshot

---

# 1. Operator

The person managing the betting operation.

Responsibilities:

- Review bets
- Confirm or reject bets
- Manage players
- Monitor balances

Example:

Operator:
Andrii

---

# 2. Player

A person who sends betting requests through WhatsApp.

Fields:

- id
- name
- phone
- balance
- status
- createdAt

Example:

Player:

Name:
Ivan

Phone:
+41 xxx

Balance:
850 USDC

---

# 3. Bet

The main business object.

A bet represents a player's betting request.

Fields:

- id
- playerId
- sport
- event
- selection
- stake
- currency
- odds
- status
- createdAt

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

---

# 4. Transaction

Every balance movement.

Examples:

Deposit:

+500 USDC

Bet:

-100 USDC

Win:

+210 USDC

Fields:

- id
- playerId
- type
- amount
- currency
- createdAt

---

# 5. Wallet

Current player balance.

Fields:

- id
- playerId
- balance
- currency

Currency:

USDC

---

# 6. Message

Stores WhatsApp communication.

Purpose:

Keep history and allow AI processing.

Fields:

- id
- playerId
- messageType
- content
- mediaUrl
- processed
- createdAt

Message types:

- TEXT
- IMAGE

---

# 7. OddsSnapshot

Stores odds verification history.

Example:

Received odds:

2.10

External odds:

2.05

Difference:

-0.05

Fields:

- id
- betId
- provider
- odds
- checkedAt

---

# Entity Relationship

Operator

|

manages

Players

|

create

Bets

|

generate

Transactions

Players

|

have

Wallets

Messages

|

create

Bet analysis

---

# MVP Priority

Phase 1:

Player

Bet

Transaction

Phase 2:

Wallet

Message

Phase 3:

OddsSnapshot
