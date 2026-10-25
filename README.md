# GyoMail

GyoMail is a Chrome extension that uses AI to flag phishing emails directly inside Gmail.

Phishing messages can be hard to recognize manually. GyoMail reads the emails shown in the inbox, sends them to a backend classifier, and displays a **Phishing** or **Legitimate** indicator next to each message, so users can spot potentially malicious emails at a glance.

The project compares three approaches to the problem (zero-shot classification, a classical TF-IDF + SVM model, and a fine-tuned transformer) and serves them behind one API.

## Features

- Phishing / legitimate classification of Gmail messages, with a confidence score
- Fast first pass on the email preview (snippet), automatically replaced by a more accurate result once the full body is available
- Batch classification of the whole inbox view in a single request
- Redis caching, so an email is never classified twice
- Three interchangeable classification engines, selectable with one environment variable
- Reproducible data and training pipeline (dataset builder, SVM training, Kaggle/Colab fine-tuning)

## Project Architecture

GyoMail consists of three main layers.

### Frontend Layer

The Chrome extension interacts directly with Gmail's DOM.

- Detects email elements dynamically
- Parses email metadata and content
- Builds structured email data
- Sends batches of emails to the API
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

Redis is used as a shared in-memory layer for rate limiting and for temporary classification-result caching.

### AI Model Layer

The AI layer decides whether an email is phishing. Three engines are available (see [Classification engines](#classification-engines)). The fine-tuned DistilRoBERTa model is the one intended for production; it is downloaded from the Hugging Face Hub and runs inside the backend, so email content is not sent to any third-party service.

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
- scikit-learn (TF-IDF + linear SVM baseline)
- `distilroberta-base`, fine-tuned for phishing detection
- `facebook/bart-large-mnli` (zero-shot baseline)

### Development / Deployment

- Docker
- Git / GitHub
- pytest
- Kaggle / Google Colab (GPU fine-tuning)
- Hugging Face Hub (model hosting)

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
                          Email[]
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
                    ┌────┘        └────────────┐
                    ▼                          ▼
              ┌───────────┐      ┌──────────────────────────┐
              │   Redis   │      │   Classification engine  │
              │           │      │                          │
              │  Cache    │      │  finetuned  (production) │
              │  Limits   │      │  svm        (baseline)   │
              └───────────┘      │  zeroshot   (baseline)   │
                                 └──────────────────────────┘
                         │
                         ▼
                 Classification Results
                         │
                         ▼
                  Gmail UI / Badges
```

## Classification engines

The engine is chosen with the `GYO_ENGINE` environment variable, or per call with `classify_email(email, engine="...")`.

| Engine | Model | Input text | Notes |
|---|---|---|---|
| `finetuned` | `distilroberta-base`, fine-tuned on ~78k emails, hosted on the Hugging Face Hub | Lightly cleaned `Subject:` + `Email body:` | Used in production. |
| `svm` | TF-IDF + linear SVM | Lowercased, punctuation and stop words removed (`preprocess.py`) | Cheap baseline. Scores are not calibrated probabilities. |
| `zeroshot` | `facebook/bart-large-mnli` (NLI-based zero-shot) | Sender, subject, preview and body | The original approach. Not accurate enough on real emails. |

The code default is `svm`; set `GYO_ENGINE=finetuned` to run the production model.

Each model needs its own text preparation, and mixing them up (for example feeding raw text to the SVM) lowers accuracy. The SVM learns from word counts, so stripped text is ideal for it. A pretrained transformer was trained on natural text, so it works best with punctuation, capitalization and links intact.

## API

All endpoints accept the same email object:

```json
{
  "id": "18c3f2a9b7d",
  "sender": { "name": "PayPal Support", "email": "support@example.com" },
  "subject": "Urgent: verify your account",
  "snippet": "Your account has been limited...",
  "timestamp": "2026-10-25T10:00:00Z",
  "body": "Full email text or HTML (optional)"
}
```

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check, including the Redis connection status. |
| `POST` | `/send-email` | Classify a batch: `{"emails": [ ... ]}`. |
| `POST` | `/classify-email` | Classify a single email. |

`/send-email` returns:

```json
{
  "Results": [
    { "email_id": "18c3f2a9b7d", "label": "Phishing", "score": 0.97, "body_analyzed": true }
  ]
}
```

`label` is `Phishing` or `Legitimate`. `score` is the model's confidence in that label. `body_analyzed` tells whether the result comes from the full body or only from the preview.

## Caching

Results are stored in Redis as one hash per email under `gyomail:email:<id>`, with the fields `label`, `score` and `body_analyzed`. Only the verdict is cached, never the email content.

The body always has priority over the snippet:

| Cached result | New request | What happens |
|---|---|---|
| none | any | Classify and store. |
| snippet only | snippet only | Return the cached result. |
| snippet only | has a body | Classify again and **overwrite** the entry. |
| body | any | Return the cached result. |

Both endpoints share one function (`classify_with_cache` in `main.py`), so the rule is defined in a single place.

Cached results do not record which engine produced them. After switching engines or model versions, clear the cache (`redis-cli FLUSHDB`) or you will keep receiving the old model's answers.

## Model and training

### Data

The training set is built from the six raw files of the public [Phishing Email Dataset](https://arxiv.org/abs/2405.11619) (Al-Subaiey et al., 2024), which merges the Enron, Ling, CEAS, Nazario, Nigerian Fraud and SpamAssassin corpora. 82,486 emails (about 52% spam/phishing) become **77,866** after cleaning and deduplication:

| Source | Legitimate | Phishing |
|---|---:|---:|
| CEAS | 17,111 | 18,935 |
| Enron | 14,455 | 13,936 |
| Ling | 2,400 | 457 |
| Nazario | 0 | 1,536 |
| Nigerian Fraud | 0 | 3,279 |
| SpamAssassin | 4,076 | 1,681 |

`build_dataset.py` does the following:

- Loads the six raw CSVs (it tolerates the `Lable` typo in `Ling.csv` and different file-name capitalization)
- Applies the same HTML and text cleaning used in production, and builds the text as `Subject:` + `Email body:` (no sender, no date)
- Drops mailbox-internal junk rows, empty or very short texts, and exact or near duplicates (digits and case are ignored when comparing, which catches templated emails)
- Undoes the pre-tokenized formatting of the Enron and Ling files (lowercase text with spaces around punctuation)
- Lowercases 30% of the natural-case training rows, so letter case cannot become a shortcut (the Nigerian-fraud emails are mostly ALL CAPS and always phishing)
- Writes a stratified 80/10/10 train / validation / test split (62,292 / 7,787 / 7,787)

### Fine-tuned model

`finetune_kaggle.py` fine-tunes `distilroberta-base` for 2 epochs on a Kaggle T4 x2 GPU (learning rate 2e-5, effective batch size 64, maximum 256 tokens, mixed precision) and pushes the model to the Hugging Face Hub. Validation results:

| Epoch | Validation loss | Accuracy | Precision | Recall | F1 |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.0508 | 0.9923 | 0.9960 | 0.9890 | 0.9924 |
| 2 | 0.0612 | 0.9927 | 0.9965 | 0.9892 | 0.9928 |

At the end of training the script also prints a per-source report (false-alarm and miss rate for each corpus) and a table of precision, recall and false-alarm rate for several decision thresholds.

### SVM baseline

`svmModel.py` trains a TF-IDF (unigrams and bigrams) + linear SVM on the dataset's pre-cleaned text, using `preprocess.py` for cleaning. It reached 0.99 on a random split but labeled most real emails as phishing, which made it unusable in practice.

## Getting started

### 1. Backend

Requirements: Python 3.10+, a running Redis server, and the packages `fastapi`, `uvicorn`, `redis`, `pydantic`, `transformers`, `torch`, `joblib` and `scikit-learn`.

```bash
# Redis (for example with Docker)
docker run -d -p 6379:6379 redis

# From the backend folder
uvicorn main:app --reload
```

Then open `http://localhost:8000/`. The response should report that Redis is connected.

### 2. Configure the model

```bash
export GYO_ENGINE=finetuned
export GYO_MODEL_REPO=your-username/gyomail-phishing   # your Hugging Face model repo
export HF_TOKEN=hf_...                                  # only needed if the repo is private
```

The first request downloads the model (about 330 MB) into the local Hugging Face cache. Load it once at startup so the first user does not wait.

| Variable | Purpose | Default |
|---|---|---|
| `GYO_ENGINE` | `finetuned`, `svm` or `zeroshot` | `svm` |
| `GYO_MODEL_REPO` | Hugging Face repo of the fine-tuned model | placeholder |
| `HF_TOKEN` | Read token for a private repo | none |
| `GYO_SVM_PATH` | Path to the trained SVM (`.joblib`) | `phishing_svm.joblib` |

Two constants in `AI/AILayer.py` also matter. `FINETUNED_THRESHOLD` (default 0.5) is the phishing probability above which an email is labeled Phishing. Raising it produces fewer false alarms, at the cost of missing some phishing emails. `SVM_INCLUDE_SENDER` controls whether the SVM sees the sender.

### 3. Extension

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the build output folder.

### 4. Retrain the model

1. Download the six raw CSV files of the dataset into a `datasets/` folder.
2. Build the training data:
   ```bash
   python build_dataset.py --dir datasets/ --out models/finetuned_dataset.csv
   ```
   Review the table of raw-text statistics and the sample printed for each source before training.
3. Upload the CSV to Kaggle (or Colab), turn on a GPU and the internet, add your Hugging Face write token as the secret `HF_TOKEN`, set `HF_REPO_ID` in `finetune_kaggle.py`, and run it.
4. Clear the Redis cache so old results do not mask the new model.

## Project structure

```text
backend/
├── main.py                 FastAPI app, endpoints and cache rules
├── db.py                   Redis client and cache functions
├── models/
│   ├── email.py            EmailRequest, EmailBatch
│   └── sender.py           Sender
└── AI/
    ├── AILayer.py          Engines: finetuned, svm, zeroshot
    ├── preprocess.py       Text cleaning for the SVM
    ├── build_dataset.py    Builds the training CSV from the raw dataset
    ├── svmModel.py         Trains the TF-IDF + SVM baseline
    └── finetune_kaggle.py  Fine-tunes and uploads the transformer (Kaggle / Colab)
```

## Evaluation and known limitations

- **Offline scores do not transfer to real inboxes.** Both the SVM and the transformer score about 99% on a random split of the dataset. In informal testing on real emails, the fine-tuned model reaches roughly 75 to 80% accuracy, and the SVM mislabeled most legitimate emails as phishing. This is a dataset-shift problem, not a bug.
- **The dataset is old.** Most emails date from the 2000s, and the legitimate class is largely Enron business mail and mailing-list posts. Modern newsletters, receipts and notifications are under-represented, which causes false alarms. Current phishing techniques (lookalike HTTPS domains, QR codes, AI-written text) are also missing.
- **Source shortcuts.** Models can learn which corpus an email came from instead of what makes it phishing, for example the lowercase formatting of Enron and Ling, or the ALL CAPS of Nigerian-fraud emails. The dataset builder reduces these shortcuts but cannot remove them entirely.
- **Previews are less reliable than full bodies.** The model was trained on subject plus body, so results based only on the snippet (`body_analyzed: false`) are weaker. They are replaced automatically once the body arrives.
- **Scores are model confidence, not guarantees.** The SVM's scores are not calibrated probabilities.
- **English only.**

## Roadmap

- Collect user feedback (correct / wrong) and retrain on real, labeled emails from Gmail, which is the most effective way to close the gap between offline and real-world accuracy
- Tune the decision threshold from a labeled evaluation set of real emails
- Store the engine name with each cached result, so switching models does not require clearing the cache
- Add sender and link features
- Support more categories (marketing, newsletter, recruitment) and more languages

## Data and attribution

The model was trained on the Phishing Email Dataset, released under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It combines the Enron, Ling, CEAS, Nazario, Nigerian Fraud and SpamAssassin corpora. If you use the data, please cite:

> Al-Subaiey, A., Al-Thani, M., Alam, N. A., Antora, K. F., Khandakar, A., & Zaman, S. A. U. (2024). *Novel Interpretable and Robust Web-based AI Platform for Phishing Email Detection.* arXiv:2405.11619. https://arxiv.org/abs/2405.11619