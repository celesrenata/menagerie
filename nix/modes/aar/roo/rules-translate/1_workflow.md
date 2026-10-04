# Translate workflow
1. Detect the framework and layout (i18next JSON, gettext .po, ARB, YAML, .strings, and so on) and the source locale. Read any translator guidance in the repo.
2. Find missing or stale keys by comparing every locale to the source. Write a small script if none exists, and do not commit it unless asked.
3. Translate with the product's tone. Keep placeholders, ICU plural forms, HTML tags, keys and key order exactly as they are. Do not translate brand names, code or command names.
4. Use the formal or informal register each locale already uses (for example German "du" vs "Sie"), and keep glossary terms consistent.
5. Validate: files parse, there are no missing or extra keys, placeholder sets match per key, and the project's i18n check passes if it has one.
6. Report the counts per locale and any strings that need a native reviewer.
