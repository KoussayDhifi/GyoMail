
<div align="center">

<img src="extension/public/icons/icon1024.png" alt="GyoMail eye icon" width="150">

# GyoMail

### Give your inbox Gyo.

**AI-assisted phishing detection, directly inside Gmail.**


[![Chrome Extension](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/)
[![Python](https://img.shields.io/badge/Python-FastAPI-3776AB?logo=python&logoColor=white)](https://fastapi.tiangolo.com/)
[![Redis](https://img.shields.io/badge/Redis-Caching-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Hugging Face](https://img.shields.io/badge/AI-Hugging%20Face-FFD21E?logo=huggingface&logoColor=black)](https://huggingface.co/)


</div>

---

## Why GyoMail?

The name **GyoMail** comes from *Gyo*, a technique in *Hunter × Hunter* that focuses aura around the eyes, allowing its user to see things that would otherwise remain hidden.

Gon uses Gyo to reveal what ordinary vision misses. I chose the name because that is exactly the idea behind this project: give your inbox an extra pair of eyes to help uncover suspicious emails hiding among legitimate messages.

<div align="center">

<a href="https://tenor.com/view/gyo-hxh-gif-2465394271599027089">
  <img src="https://media1.tenor.com/m/IjbXBx3xY5EAAAAd/gyo-hxh.gif" alt="Gon using Gyo in Hunter x Hunter" width="80%">
</a>

<sub>Gon using Gyo · GIF hosted by <a href="https://tenor.com/view/gyo-hxh-gif-2465394271599027089">Tenor</a></sub>

</div>

## Overview

GyoMail is a Chrome extension that uses AI to flag potentially phishing emails directly inside Gmail.

The extension detects visible email messages, extracts their available metadata, sends them to a backend classifier, and displays a **Phishing** or **Legitimate** indicator in the Gmail interface.

The project explores three approaches to phishing detection, alongside language-specific classification for Arabic emails:

- **Fine-tuned DistilRoBERTa:** the intended primary English classification engine.
- **TF-IDF + linear SVM:** a lightweight classical machine-learning baseline.
- **BART zero-shot classification:** the original approach, retained for comparison.
- **AraBERT:** an experimental classification path for Arabic emails.

The goal is to make suspicious messages easier to spot while exploring the practical challenges of deploying text classification in a real inbox.

## Features

- Phishing and legitimate email classification.
- Classification scores displayed alongside the verdict.
- Fast initial classification using the inbox preview.
- Reclassification when the full email body becomes available.
- Batch classification of visible inbox messages.
- Redis-backed classification-result caching.
- Shared caching logic for single-email and batch endpoints.
- Interchangeable classification engines configured through `GYO_ENGINE`.
- Language detection to help identify the appropriate classification path.
- Experimental Arabic email classification using AraBERT.
- Warnings for languages where classification reliability is limited.
- Dataset preparation, SVM training, and transformer fine-tuning scripts.

## Architecture

GyoMail consists of three main layers.

### 1. Chrome extension

The extension interacts with Gmail's DOM and is responsible for:

- Detecting email elements dynamically.
- Extracting sender, subject, snippet, timestamp, and email ID.
- Parsing the currently opened email when its body becomes available.
- Sending email data to the backend.
- Receiving classification results.
- Injecting classification badges into Gmail.
- Managing extension-side state and preferences.

**Technologies:** TypeScript, HTML, CSS, Chrome Extension Manifest V3, Vite.

### 2. FastAPI backend

The backend acts as the interface between Gmail and the AI classifier.

It handles:

- Request validation with Pydantic.
- Single-email and batch-classification endpoints.
- Email ID normalization.
- Redis cache lookup and updates.
- Classification-engine selection.
- Language metadata and warnings.
- Error handling and logging.
- Rate limiting where configured.

Redis provides shared in-memory storage for rate limiting and temporary classification results.

### 3. AI classification layer

The AI layer determines whether an email should be labeled phishing or legitimate.

It supports multiple classification approaches, including a fine-tuned English transformer, classical machine learning, zero-shot classification, and an experimental Arabic classification path.

Language detection helps identify potential language-specific limitations, but it is not infallible. Incorrect language detection can lead to the wrong classification path being selected.

## Classification pipeline

```text

                         Gmail Inbox
                             |
                             v
                     Chrome Extension
                             |
                    Detect visible emails
                             |
                    Extract email metadata
                             |
                             v
                      FastAPI Backend
                             |
                     Normalize email ID
                             |
                             v
                       Redis Lookup
                             |
                  +----------+----------+
                  |                     |
               Cache Hit             Cache Miss
                  |                     |
                  |                     v
                  |              Language Detection
                  |                     |
                  |              +------+------+ 
                  |              |             |
                  |              v             v
                  |          English /      Arabic
                  |           French          |
                  |              |             v
                  |              |          AraBERT
                  |              |       (Experimental)
                  |              v             |
                  |       Fine-tuned           |
                  |       DistilRoBERTa        |
                  |              |             |
                  |              +------+------+
                  |                     |
                  |                     v
                  |             Classification Result
                  |                     |
                  |                     v
                  |                Cache Result
                  |                     |
                  +----------+----------+
                             |
                             v
                  Classification Response
                             |
                             v
                          Gmail UI
                    Phishing / Legitimate

```

### Preview-first classification

When Gmail displays an inbox row, the full message body may not yet be available. GyoMail can classify the available preview first, giving the user an early indication.

When the email body becomes available, the extension can submit the fuller content for classification. A body-based result takes priority over a snippet-only result in the shared cache logic.


### Language detection and classification

GyoMail uses language detection to help select the appropriate classification path.

- **English:** Classified using the fine-tuned DistilRoBERTa model.
- **French:** Uses the same fine-tuned DistilRoBERTa model as English. However, French classification is unreliable because the model's fine-tuning and training data are primarily oriented toward English. French emails may still receive predictions, but results can be inconsistent or influenced by English-language patterns.
- **Arabic:** Uses AraBERT through an experimental classification path. Its predictions are not consistently accurate and should be treated as experimental.
- **Other languages:** Support is limited and depends on the available classification logic.

Because English and French share the same model, the classifier does not provide a dedicated French-language model. French emails may produce a result, but that does not mean the result is dependable. Emails containing a mixture of English and French may also be classified based on patterns learned from English text, potentially affecting the verdict.

Language detection itself can also make mistakes, particularly with short snippets, mixed-language messages, or emails containing very little text.

Treat all predictions as assistance rather than proof that an email is malicious or safe.


### Cache behavior

| Cached result | Incoming request | Behavior |
|---|---|---|
| No result | Any request | Classify and cache |
| Snippet-only | Snippet-only | Reuse cached result |
| Snippet-only | Full body available | Reclassify and overwrite |
| Full body | Any later request | Reuse body-based result |

This avoids unnecessary model inference while ensuring that a preview-only result does not permanently replace a classification based on the full message.

## Classification engines

The engine is selected using the `GYO_ENGINE` environment variable or, where supported, by passing an engine directly to the classifier.

| Engine / path | Model | Input | Purpose |
|---|---|---|---|
| `finetuned` | Fine-tuned `distilroberta-base` | Subject and email body | Intended primary English classifier |
| `svm` | TF-IDF + linear SVM | Preprocessed text | Classical ML baseline |
| `zeroshot` | `facebook/bart-large-mnli` | Sender, subject, preview, and body | Original zero-shot baseline |
| Arabic path | AraBERT | Arabic email text | Experimental Arabic classification |

The code default is `svm`. Set `GYO_ENGINE=finetuned` to select the fine-tuned transformer.

The Arabic path is intended for Arabic emails, but its accuracy remains limited. French emails are also not reliably classified.

Each model requires its own preprocessing. The SVM relies on its text-cleaning and TF-IDF pipeline, while transformer models are designed to process natural text. Using the wrong preprocessing can significantly affect results.

### Fine-tuned DistilRoBERTa

The fine-tuned engine uses `distilroberta-base`, trained on a cleaned phishing-email dataset. The model is downloaded from the Hugging Face Hub and runs inside the configured backend.

### TF-IDF + SVM

The classical baseline uses TF-IDF features built from unigrams and bigrams, followed by a linear Support Vector Machine. It is computationally inexpensive, but its real-world false-positive behavior was problematic during informal testing.

### BART zero-shot classification

The original engine uses `facebook/bart-large-mnli` to classify emails without task-specific fine-tuning. It was retained to compare the initial zero-shot approach with the other models.

### AraBERT for Arabic emails

AraBERT provides a language-specific path for Arabic email classification. It is included to explore multilingual phishing detection, but its current accuracy is limited.

Its predictions should be treated as experimental. They must not be considered reliable evidence that an email is either malicious or safe.

## Tech stack

| Component | Technologies |
|---|---|
| Browser extension | TypeScript, HTML, CSS, Vite |
| Extension platform | Chrome Extension Manifest V3 |
| Backend | Python, FastAPI, Pydantic |
| Cache | Redis |
| Transformer models | Hugging Face Transformers, PyTorch |
| Classical ML | scikit-learn, TF-IDF, linear SVM |
| Training | Kaggle / Google Colab |
| Model hosting | Hugging Face Hub |
| Development | Git, Docker, pytest |

## API reference

All endpoints use structured email objects validated by the backend.

### Email object

Example request object:

```json
{
  "id": "18c3f2a9b7d",
  "sender": {
    "name": "PayPal Support",
    "email": "support@example.com"
  },
  "subject": "Urgent: verify your account",
  "snippet": "Your account has been limited...",
  "timestamp": "2026-10-25T10:00:00Z",
  "body": "Full email text or HTML (optional)"
}
```

### Available endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check and Redis connection status |
| `POST` | `/send-email` | Classify a batch of emails |
| `POST` | `/classify-email` | Classify one email |

### Batch request

```json
{
  "emails": [
    {
      "id": "18c3f2a9b7d",
      "sender": {
        "name": "PayPal Support",
        "email": "support@example.com"
      },
      "subject": "Urgent: verify your account",
      "snippet": "Your account has been limited...",
      "timestamp": "2026-10-25T10:00:00Z",
      "body": ""
    }
  ]
}
```

### Example response

```json
{
  "Results": [
    {
      "email_id": "18c3f2a9b7d",
      "label": "Phishing",
      "score": 0.97,
      "body_analyzed": true,
      "detected_language": "en",
      "language_warning": null
    }
  ]
}
```

Response fields:

- `email_id`: ID associated with the email.
- `label`: predicted label, either `Phishing` or `Legitimate`.
- `score`: model-provided score associated with the classification.
- `body_analyzed`: whether the classification used the full body.
- `detected_language`: detected-language metadata, when available.
- `language_warning`: optional warning when language limitations may affect reliability.

The precise interpretation of `score` depends on the active engine. In particular, the SVM score should not be interpreted as a calibrated probability.

## Getting started

### Prerequisites

- Python 3.10 or newer.
- Node.js and npm.
- Redis.
- The backend dependencies used by the project.
- A Hugging Face model repository if using the fine-tuned engine.

### 1. Start Redis

For local development, Redis can be started with Docker:

```bash
docker run -d --name gyomail-redis -p 6379:6379 redis
```

Make sure the backend Redis configuration points to this instance.

### 2. Start the backend

Navigate to the backend directory, install the project's Python dependencies, and run:

```bash
uvicorn main:app --reload
```

Open [http://localhost:8000/](http://localhost:8000/). The health endpoint should indicate whether Redis is connected.

### 3. Configure the classifier

Example environment configuration:

```bash
export GYO_ENGINE=finetuned
export GYO_MODEL_REPO=your-username/gyomail-phishing

# Required only if the Hugging Face repository is private:
export HF_TOKEN=hf_...
```

Replace the example model repository with the actual repository containing the trained model.

| Variable | Purpose |
|---|---|
| `GYO_ENGINE` | Selects `finetuned`, `svm`, or `zeroshot` |
| `GYO_MODEL_REPO` | Hugging Face repository containing the fine-tuned model |
| `HF_TOKEN` | Optional token for a private model repository |
| `GYO_SVM_PATH` | Path to the trained SVM `.joblib` file |

The project also uses `FINETUNED_THRESHOLD` to control the transformer decision threshold and `SVM_INCLUDE_SENDER` to control whether the SVM receives sender information. Refer to the defaults in `AI/AILayer.py`.

The first transformer request may download model weights into the local Hugging Face cache.

### 4. Build the Chrome extension

From the extension directory:

```bash
npm install
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the build output directory generated by Vite.

Make sure the extension's API URL points to the running backend. The extension cannot classify emails if the backend is unreachable.

## Dataset and model training

The fine-tuning process used multiple public datasets to improve coverage of phishing and legitimate emails across English and Arabic.

- **[English–Arabic Phishing Email Corpus](https://www.kaggle.com/datasets/saidasalloum/englisharabic-phishing-email-corpus)** by Said Asalloum. Includes bilingual phishing-email data, supporting experimentation with English and Arabic classification.
- **[Phishing Email Dataset](https://www.kaggle.com/datasets/naserabdullahalam/phishing-email-dataset)** by Naser Abdullah Alam. A collection combining six email corpora: Enron, Ling, CEAS, Nazario, Nigerian Fraud, and SpamAssassin.
- **[Arabic Phishing and Legitimate Emails Samples](https://www.kaggle.com/datasets/rianshalyozbaky/arabic-phishing-and-legitimate-emails-samples)** by Rian Shalyozbaky. Provides Arabic phishing and legitimate email samples for experiments with Arabic-language classification.

These datasets complemented the training pipeline by providing additional examples for fine-tuning and exploring multilingual phishing detection, particularly Arabic email classification.

Dataset preprocessing, label normalization, and duplicate handling are important when combining sources, as differences in formatting, class balance, and collection methods can introduce bias or data leakage.

### Fine-tuning

The `finetune_kaggle.py` script fine-tunes `distilroberta-base` and can upload the resulting model to the Hugging Face Hub.

The recorded validation results after two epochs were:

| Epoch | Validation loss | Accuracy | Precision | Recall | F1 |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.0508 | 0.9923 | 0.9960 | 0.9890 | 0.9924 |
| 2 | 0.0612 | 0.9927 | 0.9965 | 0.9892 | 0.9928 |

These results measure performance on the prepared validation dataset. They should not be interpreted as real-world inbox accuracy.

### SVM training

`svmModel.py` trains the TF-IDF + linear SVM baseline using the project's preprocessing logic. Although the model achieved strong scores on a random dataset split, informal real-email testing exposed a high false-positive rate.

### Reproducing the training pipeline

1. Download the six raw CSV files into a `datasets/` directory.
2. Run `build_dataset.py` to generate the cleaned dataset.
3. Review the dataset statistics and sample rows.
4. Run `finetune_kaggle.py` in a GPU-enabled Kaggle or Colab environment.
5. Configure the Hugging Face repository and credentials.
6. Upload the resulting model.
7. Clear the relevant Redis cache before evaluating the updated model.

Use the exact command-line arguments and configuration defined by the scripts in the repository.

## Privacy and security

GyoMail sends email data from the Chrome extension to its configured backend for classification.

In the intended local inference setup, model inference runs inside that backend rather than requiring email content to be submitted to a third-party classification API. However, actual privacy depends on the deployment, logging configuration, hosting provider, and any external services used.

Before using GyoMail with sensitive mail, review where email data is transmitted and whether it is retained in logs or other systems.

GyoMail is an assistive security tool, not a replacement for careful inspection. Do not trust a suspicious link or submit credentials solely because an email was labeled `Legitimate`.

## Evaluation and limitations

### Dataset shift

The prepared dataset produced validation accuracy around 99%, but informal testing on real emails was substantially less accurate. Training and validation data do not perfectly represent modern inboxes.

### Older and imbalanced source corpora

The dataset contains older email corpora and does not fully represent modern newsletters, receipts, notifications, QR-code phishing, lookalike domains, or current attacker techniques.

### Source-specific shortcuts

Models can learn formatting and other characteristics associated with particular datasets instead of the underlying signs of phishing. Dataset cleaning can reduce these shortcuts but cannot guarantee their removal.

### Preview-only classification

A classification based on a snippet contains less information than one based on the full email body. Preview-only results should be treated as preliminary.

### Language support

GyoMail includes language detection and an experimental Arabic classification path using AraBERT. However, Arabic classification is not consistently accurate, and French email classification is also unreliable.

Language detection can misidentify emails, particularly when they contain mixed languages, short snippets, or limited text. A language warning indicates a known limitation; it does not make the classification reliable.

Do not treat predictions for Arabic, French, or other insufficiently supported languages as dependable phishing verdicts.

### Scores are not guarantees

Model scores are not proof that an email is malicious or safe. The SVM score is not a calibrated probability, and all engines can produce false positives and false negatives.

## Project structure

The backend is organized approximately as follows:

```text
backend/
├── main.py                 FastAPI endpoints and cache policy
├── db.py                   Redis client and cache functions
├── models/
│   ├── email.py            EmailRequest and EmailBatch
│   └── sender.py           Sender model
└── AI/
    ├── AILayer.py          Classification engine selection
    ├── preprocess.py       SVM text preprocessing
    ├── build_dataset.py    Dataset preparation
    ├── svmModel.py         TF-IDF + SVM training
    └── finetune_kaggle.py  Transformer fine-tuning
```

The extension has its own source tree containing Gmail DOM integration, API communication, background/service-worker messaging, UI rendering, and Vite configuration.

## Data and attribution

The training data is based on the [Phishing Email Dataset](https://arxiv.org/abs/2405.11619), released under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

If you use the dataset, cite the following paper:

> Al-Subaiey, A., Al-Thani, M., Alam, N. A., Antora, K. F., Khandakar, A., & Zaman, S. A. U. (2024). *Novel Interpretable and Robust Web-based AI Platform for Phishing Email Detection.* arXiv:2405.11619. https://arxiv.org/abs/2405.11619

## Benchmark

### Fine-tuned DistilRoBERTa: API evaluation

The fine-tuned DistilRoBERTa model was evaluated through the running GyoMail FastAPI backend using 30 synthetic English emails: 15 legitimate emails and 15 phishing emails. Predictions were compared against their expected labels.

| Metric | Result |
|---|---:|
| Total emails | 30 |
| Correct predictions | 25 / 30 |
| Incorrect predictions | 5 / 30 |
| Accuracy | 83.33% |
| Phishing precision | 85.71% |
| Phishing recall | 80.00% |
| Phishing F1-score | 82.76% |

#### Confusion matrix

Rows represent actual labels; columns represent predicted labels.

| Actual label | Predicted: Legitimate | Predicted: Phishing |
|---|---:|---:|
| Legitimate | 13 | 2 |
| Phishing | 3 | 12 |

The model correctly classified 13 of 15 legitimate emails and detected 12 of 15 phishing emails. It incorrectly flagged two legitimate emails and missed three phishing emails.

#### Interpretation

The evaluation achieved **83.33% accuracy**, with an **82.76% F1-score for phishing detection**. Phishing precision of 85.71% indicates that most emails flagged as phishing in this test set were genuinely phishing examples, while recall of 80.00% indicates that the model detected four out of every five phishing examples.

These results provide an initial benchmark for the fine-tuned model integrated into GyoMail's API pipeline. They should not be interpreted as a reliable estimate of real-world production accuracy: the evaluation used only 30 synthetic emails, and its balanced class distribution does not necessarily reflect a real inbox.

#### Reproducibility

The evaluation script sends the test emails directly to the `/classify-email` endpoint and exports the results for further analysis.

Generated artifact:

- `evaluation_results/summary.txt`: evaluation metrics and confusion matrix.

This benchmark serves as an initial reference point for future experiments involving larger datasets, unseen real-world emails, and comparisons between the fine-tuned transformer, TF-IDF + SVM, and zero-shot BART classifiers.


## Final release

This release brings together the Chrome extension, FastAPI backend, Redis caching, language detection, and interchangeable classification engines.

The project retains its training and evaluation pipeline so the approaches can be reproduced and compared. Fine-tuned DistilRoBERTa is the intended primary English classifier, while AraBERT provides an experimental Arabic path. Real-world accuracy and language limitations remain explicit constraints.

---

<div align="center">

**GyoMail: give your inbox Gyo.**

*Inspired by Hunter × Hunter. Built to help you look twice.*

</div>
