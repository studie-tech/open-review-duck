# Responsive visual review

The lab now uses a compact workspace header, a dataset selector with an adjacent create action, and consistent view tabs. The introductory guide is available on demand. On phones, case labels sit beneath full-width titles, experiment history uses a bounded selector, the review stage uses a native selector, and metrics use aligned rows. Editors wrap their controls and constrain source/prompt scrolling. Scoring explanations and run limits remain accessible in disclosures.

Visual review and the browser regression test cover 320, 390, 768 and 1440 pixel viewports, plus light and dark themes. The test checks document overflow in the dataset, case editor, results and prompt composer, and asserts that the dataset heading remains within the first 430 pixels. Screenshots omit only the Next.js development indicator.

Validation: `pnpm check` passed (2,581 unit tests), and the expanded evaluation Playwright workflow passed. The examples and model responses use the deterministic QA provider.

| View | Small phone (320 px) | Tablet (768 px) | Desktop (1440 px) |
| --- | --- | --- | --- |
| Dataset | [Screenshot](screenshots/responsive-cases-320.png) | [Screenshot](screenshots/responsive-cases-768.png) | [Screenshot](screenshots/responsive-cases-1440.png) |
| Case editor | [Screenshot](screenshots/responsive-editor-320.png) | [Screenshot](screenshots/responsive-editor-768.png) | [Screenshot](screenshots/responsive-editor-1440.png) |
| Prompt composer | [Screenshot](screenshots/responsive-prompt-320.png) | [Screenshot](screenshots/responsive-prompt-768.png) | [Screenshot](screenshots/responsive-prompt-1440.png) |
| Results | [Screenshot](screenshots/responsive-results-320.png) | [Screenshot](screenshots/responsive-results-768.png) | [Screenshot](screenshots/responsive-results-1440.png) |

## Initial phone viewport

![Phone overview](screenshots/responsive-mobile-overview.png)

## Dark theme

![Phone results in dark theme](screenshots/responsive-results-dark-390.png)
