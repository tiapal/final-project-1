"""Translate the interface labels once and save them in data/ui_translations.json, so the app ships with them.

Run from the repo folder:  python pretranslate_ui.py
Run it again whenever you change backend/ui_strings.py (the app ignores a saved file that no longer matches).
Uses the model (about one call per language).
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from backend import agents, db
from backend.ui_strings import UI_STRINGS

LANGS = ["es", "zh", "vi", "ar", "ceb"]


def one(lang: str) -> tuple[str, dict]:
    print(f"translating {agents.lang_name(lang)}...", flush=True)
    return lang, agents.translate_ui(UI_STRINGS, lang, "pretranslate", use_shipped=False)


if __name__ == "__main__":
    with ThreadPoolExecutor(len(LANGS)) as pool:
        results = dict(pool.map(one, LANGS))
    missing = {lang: [k for k in UI_STRINGS if results[lang][k] == UI_STRINGS[k]] for lang in LANGS}
    out = {"hash": agents.ui_hash(UI_STRINGS), "languages": results}
    agents.PRETRANSLATED.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {agents.PRETRANSLATED} ({len(UI_STRINGS)} labels x {len(LANGS)} languages)")
    for lang, keys in missing.items():
        print(f"  {lang}: {len(keys)} labels came back identical to English (normal for words like 'Zoom', 'Organic'...)")
    sys.exit(0)
