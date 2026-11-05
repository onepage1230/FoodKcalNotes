# 05：文件同步

**What to build:** 讓文件和程式一致：README 中英兩份同步說明體重紀錄、趨勢圖、計劃進度與蛋白質下限；CLAUDE.md 加上新規則；ADR 索引與 `GLOSSARY.md` 與實作一致；spec 狀態改為已完成。

**Blocked by:** 01、02、03、04

**Status:** ready-for-agent

- [ ] README.md 與 README.en.md 同步，內容一致（含赤字期蛋白質下限與腎功能提醒）
- [ ] CLAUDE.md：體重紀錄的設計規則（目前體重取最新紀錄、起始體重固定、不自動改每日熱量目標、蛋白質公式指向 ADR 0012）
- [ ] ADR 0010 的蛋白質描述與 ADR 0012 一致，索引正確
- [ ] `GLOSSARY.md` 詞彙與實作一致，沒有實作細節
- [ ] `docs/specs/weight-tracking.md` 狀態改為已完成，並把「沒有逐項討論過的預設值」記下最終結論
- [ ] 各 ticket 的驗收項目都已勾選
