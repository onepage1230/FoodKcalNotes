# 04: 文件同步

**What to build:** 使用者與未來的開發者從文件就能了解重複記錄功能：README 中英兩份描述候選餐點與「再記一次」的行為與規則（平日與假日的差別、補記時用常見時間）；詞彙表與 ADR 索引與實作一致；spec 狀態改為已完成。

**Blocked by:** 03 假日的「最近吃過」

**Status:** in-review

- [x] README 中英兩份的功能段落同步更新，內容一致，沿用既有結構
- [x] `GLOSSARY.md` 的詞與實作和介面用語一致；若實作時用語改變，一併修正
- [x] `docs/decisions/README.md` 索引含 0011；若實作與 ADR 0011 有出入，更新 ADR
- [x] `CLAUDE.md` 只在有新的「不可違反」規則時才補（例如候選不寫食物庫）；沒有就不改
- [x] `docs/specs/repeat-meals.md` 狀態改為已完成，「討論中沒有明確決定」的預設值有最終結論
