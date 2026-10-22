import redis


redis_client = redis.Redis(
    host="localhost",
    port=6379,
    decode_responses=True
)

def get_cached_classification(email_id: str) -> dict | None:
    cached = redis_client.hgetall(f"gyomail:email:{email_id}")
    return cached or None


def save_classification(
    email_id: str,
    result: dict,
    body_analyzed: bool,
) -> None:
    redis_client.hset(
        f"gyomail:email:{email_id}",
        mapping={
            "label": result["label"],
            "score": str(result["score"]),
            "body_analyzed": str(body_analyzed).lower(),
        },
    )