# GyoMail

GyoMail is a Chrome extension that uses AI to classify emails into user-defined categories such as phishing, marketing, newsletter, recruitment, or legitimate emails.

The goal is to help users identify potentially malicious or unwanted emails that may be difficult to recognize manually.

The project explores the application of zero-shot AI models to cybersecurity and email classification.

## Project Architecture

GyoMail consists of three main layers:

### Frontend Layer

The Chrome extension interacts directly with Gmail's DOM.

- Detects email elements dynamically
- Parses email metadata and content
- Builds structured email data
- Sends batches of emails and user-defined categories to the API
- Receives classification results
- Injects classification indicators into the Gmail interface
- Stores user preferences using Chrome Storage

### API Layer

The FastAPI backend acts as the interface between the extension and the AI model.

- Request validation
- Rate limiting
- Classification-result caching
- Error handling
- Logging
- Forwarding cache misses to the classifier

Redis is used as a shared in-memory layer for rate limiting and temporary classification-result caching.

### AI Model Layer

The AI layer performs zero-shot classification using a Hugging Face model.

- Zero-shot classification
- User-defined categories
- Classification scores

## Tech Stack

### Frontend

- TypeScript
- HTML / CSS
- Chrome Extension Manifest V3
- Vite

### API

- Python
- FastAPI
- Pydantic
- Redis

### AI

- Hugging Face Transformers
- PyTorch
- `MoritzLaurer/DeBERTa-v3-large-zeroshot-v2.0`

### Development / Deployment

- Docker
- Git / GitHub
- pytest

## Architecture

```text
                  ┌─────────────────────┐
                  │    Gmail Website    │
                  └──────────┬──────────┘
                             │
                         Gmail DOM
                             │
                             ▼
                  ┌─────────────────────┐
                  │   Chrome Extension  │
                  │                     │
                  │  Detector           │
                  │  Parser             │
                  │  Renderer           │
                  │  Chrome Storage     │
                  └──────────┬──────────┘
                             │
                       Email[] + Categories
                             │
                             ▼
                  ┌─────────────────────┐
                  │       FastAPI       │
                  │                     │
                  │  Validation         │
                  │  Rate Limiting      │
                  │  Cache Lookup       │
                  │  Classification     │
                  └──────┬────────┬─────┘
                         │        │
                    ┌────┘        └────┐
                    ▼                  ▼
              ┌───────────┐      ┌────────────┐
              │   Redis   │      │  DeBERTa   │
              │           │      │ Zero-Shot  │
              │  Cache    │      │ Classifier │
              │  Limits   │      └────────────┘
              └───────────┘
                         │
                         ▼
                 Classification Results
                         │
                         ▼
                  Gmail UI / Badges
```