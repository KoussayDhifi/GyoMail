from transformers import pipeline
from models.email import EmailRequest
import re
import unicodedata
from html import unescape
from html.parser import HTMLParser




CLASS_LABELS = [
    "Phishing",
    "Legitimate"
]


GyoClassifier = pipeline(
    task="zero-shot-classification",
    model="facebook/bart-large-mnli",
    tokenizer="facebook/bart-large-mnli"
)


class EmailHTMLParser(HTMLParser):
    BLOCK_TAGS = {
        "address", "article", "blockquote", "div", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6", "header",
        "li", "main", "ol", "p", "section", "table", "tr", "ul",
    }

    SKIP_TAGS = {"script", "style", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0
        self.link_stack = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return

        if self.skip_depth:
            return

        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

        if tag == "br":
            self.parts.append("\n")

        elif tag == "img":
            alt = attrs.get("alt", "").strip()
            if alt:
                self.parts.append(f" {alt} ")

        elif tag == "a":
            self.link_stack.append(attrs.get("href", "").strip())

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return

        if self.skip_depth:
            return

        if tag == "a" and self.link_stack:
            href = self.link_stack.pop()
            if href:
                self.parts.append(f" (link: {href}) ")

        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)

    def get_text(self):
        return "".join(self.parts)


def clean_email_text(value: str | None) -> str:
    if not value:
        return ""

    # Decode entities such as &amp;, &#x20;, and &nbsp;.
    value = unescape(value)

    # Extract readable text from HTML while retaining anchor destinations.
    parser = EmailHTMLParser()
    parser.feed(value)
    parser.close()

    text = unescape(parser.get_text())

    # Normalize Unicode, including unusual whitespace characters.
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\xa0", " ")

    # Normalize line endings and collapse excessive blank lines.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def concatenate_email(email: EmailRequest) -> str:

    sender_name = clean_email_text(email.sender.name)
    sender_address = clean_email_text(email.sender.email)
    subject = clean_email_text(email.subject)
    snippet = clean_email_text(email.snippet)
    body = clean_email_text(email.body)

    sections = []

    if sender_name or sender_address:
        sender = sender_name or "Unknown"
        if sender_address:
            sender += f" <{sender_address}>"
        sections.append(f"Sender:\n{sender}")

    if subject:
        sections.append(f"Subject:\n{subject}")

    # Gmail snippets frequently repeat the beginning of the body.
    # Include the preview when it adds information not found in the body.
    if snippet and (
        not body
        or snippet.casefold() not in body.casefold()
    ):
        sections.append(f"Email preview:\n{snippet}")

    if body:
        sections.append(f"Email body:\n{body}")

    return "\n\n".join(sections)




def classify_email(email: EmailRequest) -> dict:
    text = concatenate_email(email)

    if not text:
        raise ValueError("Email contains no classifiable text.")

    result = GyoClassifier(
        text,
        candidate_labels=CLASS_LABELS,
        hypothesis_template="This email is {}."
    )

    best_idx = result["scores"].index(max(result["scores"]))

    return {
        "email_id": email.id,
        "label": result["labels"][best_idx],
        "score": result["scores"][best_idx],
    }





