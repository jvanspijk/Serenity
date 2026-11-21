import json
import sys

from ddgs import DDGS
from ddgs.exceptions import DDGSException


query = json.load(sys.stdin)
try:
    results = DDGS(timeout=5).text(query, max_results=5, backend="auto")
except DDGSException as error:
    if str(error) != "No results found.":
        raise
    results = []

json.dump([
    {"title": item["title"][:240], "url": item["href"], "snippet": item["body"][:600]}
    for item in results
    if item.get("href", "").startswith(("https://", "http://"))
], sys.stdout)
