# accessibility_audit

Call:

```json
{ "name": "accessibility_audit", "arguments": { "url": "https://www.w3.org/WAI/demos/bad/before/home.html" } }
```

Text returned to the conversation:

```
https://www.w3.org/WAI/demos/bad/before/home.html: 5 wcag2aa rules failed across 44 elements, 12 passed, 1 needs a person.

Needs attention:
- [critical] Images must have alternative text (33 elements, image-alt).
- [critical] Select element must have an accessible name (1 element, select-name).
- [warning] Links must have discernible text (7 elements, link-name).
- [warning] Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast).
- [warning] <html> element must have a lang attribute (1 element, html-has-lang).
- [info] 1 rule could not be decided automatically and needs a person to look.
```

Structured content:

```json
{
  "url": "https://www.w3.org/WAI/demos/bad/before/home.html",
  "finalUrl": "https://www.w3.org/WAI/demos/bad/before/home.html",
  "checkedAt": "2026-09-01T11:13:42.026Z",
  "severity": "critical",
  "findings": [
    {
      "code": "a11y_image_alt",
      "severity": "critical",
      "message": "Images must have alternative text (33 elements, image-alt)."
    },
    {
      "code": "a11y_select_name",
      "severity": "critical",
      "message": "Select element must have an accessible name (1 element, select-name)."
    },
    {
      "code": "a11y_link_name",
      "severity": "warning",
      "message": "Links must have discernible text (7 elements, link-name)."
    },
    {
      "code": "a11y_color_contrast",
      "severity": "warning",
      "message": "Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast)."
    },
    {
      "code": "a11y_html_has_lang",
      "severity": "warning",
      "message": "<html> element must have a lang attribute (1 element, html-has-lang)."
    },
    {
      "code": "a11y_needs_review",
      "severity": "info",
      "message": "1 rule could not be decided automatically and needs a person to look."
    }
  ],
  "audited": true,
  "standard": "wcag2aa",
  "pageTitle": "Welcome to CityLights! [Inaccessible Home Page]",
  "violations": [
    {
      "id": "image-alt",
      "impact": "critical",
      "help": "Images must have alternative text",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/image-alt?application=axeAPI",
      "tags": [
        "cat.text-alternatives",
        "wcag2a",
        "wcag111",
        "section508",
        "section508.22.a",
        "TTv5",
        "TT7.a",
        "TT7.b",
        "EN-301-549",
        "EN-9.1.1.1",
        "ACT",
        "RGAAv4",
        "RGAA-1.1.1"
      ],
      "nodeCount": 33,
      "selectors": [
        "img[src$=\"border_left_top.gif\"]",
        "img[src$=\"border_top.gif\"]",
        "img[src$=\"border_right_top.gif\"]",
        "img[src$=\"border_left.gif\"]",
        "img[src$=\"top_logo_next_end.gif\"]"
      ]
    },
    {
      "id": "select-name",
      "impact": "critical",
      "help": "Select element must have an accessible name",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/select-name?application=axeAPI",
      "tags": [
        "cat.forms",
        "wcag2a",
        "wcag412",
        "section508",
        "section508.22.n",
        "TTv5",
        "TT5.c",
        "EN-301-549",
        "EN-9.4.1.2",
        "ACT",
        "RGAAv4",
        "RGAA-11.1.1"
      ],
      "nodeCount": 1,
      "selectors": [
        "select"
      ]
    },
    {
      "id": "link-name",
      "impact": "serious",
      "help": "Links must have discernible text",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/link-name?application=axeAPI",
      "tags": [
        "cat.name-role-value",
        "wcag2a",
        "wcag244",
        "wcag412",
        "section508",
        "section508.22.a",
        "TTv5",
        "TT6.a",
        "EN-301-549",
        "EN-9.2.4.4",
        "EN-9.4.1.2",
        "ACT",
        "RGAAv4",
        "RGAA-6.2.1"
      ],
      "nodeCount": 7,
      "selectors": [
        "#home > a[onfocus=\"blur();\"]",
        "#news > a[onfocus=\"blur();\"]",
        "#tickets > a[onfocus=\"blur();\"]",
        "#survey > a[onfocus=\"blur();\"]",
        ".story:nth-child(1) > span > a[href$=\"news.html\"][onfocus=\"blur();\"]"
      ]
    },
    {
      "id": "color-contrast",
      "impact": "serious",
      "help": "Elements must meet minimum color contrast ratio thresholds",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/color-contrast?application=axeAPI",
      "tags": [
        "cat.color",
        "wcag2aa",
        "wcag143",
        "TTv5",
        "TT13.c",
        "EN-301-549",
        "EN-9.1.4.3",
        "ACT",
        "RGAAv4",
        "RGAA-3.2.1"
      ],
      "nodeCount": 2,
      "selectors": [
        "tr[height=\"25px\"]:nth-child(2) > td[bgcolor=\"#A9B8BF\"][width=\"150px\"] > font[color=\"#41545D\"][size=\"2\"] > b",
        "tr[height=\"25px\"]:nth-child(7) > td[bgcolor=\"#A9B8BF\"][width=\"150px\"] > font[color=\"#41545D\"][size=\"2\"] > b"
      ]
    },
    {
      "id": "html-has-lang",
      "impact": "serious",
      "help": "<html> element must have a lang attribute",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.13/html-has-lang?application=axeAPI",
      "tags": [
        "cat.language",
        "wcag2a",
        "wcag311",
        "TTv5",
        "TT11.a",
        "EN-301-549",
        "EN-9.3.1.1",
        "ACT",
        "RGAAv4",
        "RGAA-8.3.1"
      ],
      "nodeCount": 1,
      "selectors": [
        "html"
      ]
    }
  ],
  "violationCount": 5,
  "affectedElements": 44,
  "passCount": 12,
  "incompleteCount": 1,
  "axeVersion": "4.13.0"
}
```
