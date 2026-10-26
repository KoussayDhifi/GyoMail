from __future__ import annotations
import unicodedata
from html import unescape
from html.parser import HTMLParser
import re
from html import unescape
from html.parser import HTMLParser
from typing import TYPE_CHECKING


if TYPE_CHECKING:  # adjust the import path to wherever your models live
    from .email import EmailBatch, EmailRequest

# NLTK English stop words, apostrophe forms removed because the tokenizer
# below splits on apostrophes ("don't" -> "don", "t").
STOP_WORDS = frozenset(
    """
    i me my myself we our ours ourselves you your yours yourself yourselves
    he him his himself she her hers herself it its itself they them their
    theirs themselves what which who whom this that these those am is are was
    were be been being have has had having do does did doing a an the and but
    if or because as until while of at by for with about against between into
    through during before after above below to from up down in out on off over
    under again further then once here there when where why how all any both
    each few more most other some such no nor not only own same so than too
    very s t can will just don should now d ll m o re ve y ain aren couldn
    didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn
    weren won wouldn
    """.split()
)

_TOKEN_RE = re.compile(r"[a-z]+|[0-9]+")  # letters and digits split apart
_HTML_HINT_RE = re.compile(r"<\s*(?:!doctype|html|body|div|p|br|table|span|a|img|style|head)\b", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


class _TextExtractor(HTMLParser):
    """Collects visible text, skipping <script>, <style>, <head> content."""

    _SKIP = {"script", "style", "head", "title"}
    _BREAKS = {"br", "p", "div", "tr", "li", "td", "table", "h1", "h2", "h3"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BREAKS:
            self._parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BREAKS:
            self._parts.append(" ")

    def handle_data(self, data):
        if not self._skip_depth:
            self._parts.append(data)

    def text(self) -> str:
        return " ".join(self._parts)


def html_to_text(raw: str) -> str:
    """Return visible text from an HTML body; plain text passes through."""
    if not raw:
        return ""
    if _HTML_HINT_RE.search(raw):
        try:
            parser = _TextExtractor()
            parser.feed(raw)
            parser.close()
            return parser.text()
        except Exception:  # malformed HTML: fall back to a crude tag strip
            return unescape(_TAG_RE.sub(" ", raw))
    return unescape(raw)  # plain text, but may hold entities such as &#39;


def clean_text(text: str, max_words: int | None = None) -> str:
    """Dataset-style cleaning: lowercase, alnum tokens, no stop words."""
    tokens = [t for t in _TOKEN_RE.findall(text.lower()) if t not in STOP_WORDS]
    if max_words is not None:
        tokens = tokens[:max_words]
    return " ".join(tokens)


def build_text(
    email: "EmailRequest",
    *,
    include_sender: bool = True,
    include_timestamp: bool = False,
) -> str:
    """Join the fields into one string: [sender] [timestamp] subject body.

    Body is used when present; otherwise the snippet (usually the first
    ~100-200 characters of the message) stands in for it.
    """
    parts: list[str] = []
    if include_sender:
        parts.append(f"{email.sender.name} {email.sender.email}")
    if include_timestamp:
        parts.append(email.timestamp)
    parts.append(email.subject or "")
    body = email.body if (email.body and email.body.strip()) else email.snippet
    parts.append(html_to_text(body or ""))
    return " ".join(p for p in parts if p)


def preprocess_email(
    email: "EmailRequest",
    *,
    include_sender: bool = True,
    include_timestamp: bool = False,
    max_words: int | None = None,
) -> str:
    """Single email -> cleaned string ready for the vectorizer / tokenizer."""
    raw = build_text(
        email, include_sender=include_sender, include_timestamp=include_timestamp
    )
    return clean_text(raw, max_words=max_words)


def preprocess_batch(
    batch: "EmailBatch", **kwargs
) -> list[tuple[str, str]]:
    """EmailBatch -> [(email_id, cleaned_text), ...], same order as the input."""
    return [(e.id, preprocess_email(e, **kwargs)) for e in batch.emails]


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

