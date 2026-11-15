"""Show the end of a text file as an error annotation on the workflow run's page.

Job logs can only be read by people signed in with admin rights to the repository; annotations show on the run's
summary page for anyone. Used by build-apps.yml when a step fails:
    python3 .github/annotate.py "Title" file.txt
"""
import sys

title, path = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8", errors="replace") as file:
    text = file.read().strip()[-3500:] or "(no error text found)"
escaped = text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
print(f"::error title={title}::{escaped}")
