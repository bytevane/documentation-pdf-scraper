"""Check generated documentation PDFs; rendered previews still need human review."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from contextlib import contextmanager

import pymupdf


def compact(text):
    # Expand typographic ligatures such as U+FB00 so "diﬀicult" matches "difficult".
    text = re.sub(r"[\ufb00-\ufb06]", lambda match: unicodedata.normalize("NFKC", match.group()), text)
    return re.sub(r"\s+", "", text.translate(str.maketrans("‘’“”", "''\"\"")))


def contains_text(expected, actual):
    # PDF text includes discretionary line-end hyphens; retain the literal
    # comparison too so authored hyphens are not silently erased.
    return (compact(expected) in compact(actual)
            or compact(expected) in compact(re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", actual)))


def normalize_font_name(name):
    without_subset = re.sub(r"^[A-Z]{6}\+", "", name or "")
    return re.sub(r"[^a-z0-9]", "", without_subset.lower())


def font_matches(expected, actual):
    expected_name = normalize_font_name(expected)
    actual_name = normalize_font_name(actual)
    return expected_name in actual_name or actual_name in expected_name


@contextmanager
def glyph_height_boxes():
    previous = pymupdf.TOOLS.set_small_glyph_heights()
    pymupdf.TOOLS.set_small_glyph_heights(True)
    try:
        yield
    finally:
        pymupdf.TOOLS.set_small_glyph_heights(previous)


def destination_key(link):
    point = link.get("to", (0, 0))
    return (link.get("page", -1), link.get("nameddest") or tuple(round(value, 2) for value in point))


def inspect_pdf(pdf_path, expectations=None):
    expectations = expectations or {}
    issues = []
    with glyph_height_boxes(), pymupdf.open(pdf_path) as doc:
        if doc.needs_pass or not doc.page_count:
            raise ValueError("PDF must be readable and contain pages")
        detailed_outline = doc.get_toc(simple=False)
        outline = [entry[:3] for entry in detailed_outline]
        toc_pages = [i for i, page in enumerate(doc)
                     if re.fullmatch(r"[ivxlcdm]+", page.get_label())]
        texts = []
        preview_pages = {0, len(doc) - 1, *toc_pages}
        toc_links = {}
        toc_annotations = 0
        used_fonts = set()
        for index, page in enumerate(doc):
            for dimension, expected_key in [(page.rect.width, "pageWidthPt"), (page.rect.height, "pageHeightPt")]:
                if expected_key in expectations and abs(dimension - expectations[expected_key]) > 1:
                    issues.append({"kind": "page_size", "page": index + 1,
                                   "dimension": expected_key, "actual": dimension, "expected": expectations[expected_key]})
            text = page.get_text()
            texts.append(text)
            words = page.get_text("words", clip=pymupdf.INFINITE_RECT())
            spans = [span for block in page.get_text("dict").get("blocks", [])
                     if block.get("type") == 0 for line in block.get("lines", [])
                     for span in line.get("spans", []) if span.get("text", "").strip()]
            used_fonts.update(span.get("font", "") for span in spans if span.get("font"))
            if "\ufffd" in text:
                issues.append({"kind": "replacement_character", "page": index + 1})
            for span in page.get_texttrace():
                if any(char[1] == 0 and not chr(char[0]).isspace() for char in span["chars"]):
                    issues.append({"kind": "missing_glyph", "page": index + 1, "font": span["font"],
                                   "context": "".join(chr(char[0]) for char in span["chars"])[:160]})
                    break
            images = page.get_image_info()
            if images:
                preview_pages.add(index)
            if not text.strip() and not images:
                issues.append({"kind": "empty_page", "page": index + 1})
            boxes = [(span["bbox"], span["text"], "text", span.get("size", 0)) for span in spans]
            boxes += [(image["bbox"], "image", "image", 0) for image in images]
            for coords, value, kind, font_size in boxes:
                box = pymupdf.Rect(coords) * page.rotation_matrix
                left = expectations.get("marginLeftPt", 0)
                right = page.rect.width - expectations.get("marginRightPt", 0)
                top = expectations.get("marginTopPt", 0)
                bottom = page.rect.height - expectations.get("marginBottomPt", 0)
                center_y = (box.y0 + box.y1) / 2
                header = (kind == "text" and expectations.get("headerZoneTopPt") is not None
                          and expectations["headerZoneTopPt"] <= center_y
                          <= expectations["headerZoneBottomPt"]
                          and font_size <= expectations.get("headerMaxFontSizePt", float("inf")))
                footer_zone = (expectations.get("footerZoneTopPt") is not None
                               and expectations["footerZoneTopPt"] <= center_y
                               <= expectations["footerZoneBottomPt"]
                               and font_size <= expectations.get("footerMaxFontSizePt", float("inf")))
                # Only the generated page label is permitted in the footer zone.
                footer = (kind == "text" and value.strip() == page.get_label()
                          and ((footer_zone and box.y1 <= page.rect.height)
                               or (expectations.get("footerZoneTopPt") is None
                                   and center_y >= bottom and box.y1 <= page.rect.height
                                   and box.x0 > page.rect.width * 0.35
                                   and box.x1 < page.rect.width * 0.65)))
                # Word rectangles include font ascenders/descenders, not only ink.
                # TeX positions the first baseline using topskip; large headings
                # can extend that rectangle above the text block without clipping.
                vertical_tolerance = 2 if value == "image" else max(4, box.height * 0.4)
                outside_page = (box.x0 < -2 or box.x1 > page.rect.width + 2
                                or box.y0 < -2 or box.y1 > page.rect.height + 2)
                outside_body = (box.x0 < left - 2 or box.x1 > right + 2
                                or box.y0 < top - vertical_tolerance
                                or box.y1 > bottom + vertical_tolerance)
                if outside_page or (outside_body and not header and not footer):
                    issues.append({"kind": "overflow", "page": index + 1,
                                   "text": value, "box": list(box)})
            for link in page.get_links():
                if link["kind"] not in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED):
                    continue
                target = link.get("page", -1)
                if not 0 <= target < len(doc):
                    issues.append({"kind": "invalid_link", "page": index + 1})
                    continue
                if index in toc_pages:
                    toc_annotations += 1
                    key = destination_key(link)
                    entry = toc_links.setdefault(key, {"page": index, "target": target, "boxes": []})
                    entry["boxes"].append(link["from"])

        for entry in toc_links.values():
            page = doc[entry["page"]]
            words = page.get_text("words")
            right_numbers = [word for word in words if re.fullmatch(r"\d+", word[4])
                             and word[0] > page.rect.width * 0.7]
            right_edge = max((word[2] for word in right_numbers), default=page.rect.width)
            top = min(box.y0 for box in entry["boxes"])
            bottom = max(box.y1 for box in entry["boxes"])
            numbers = [word[4] for word in right_numbers if word[2] >= right_edge - 2
                       and top - 1 <= (word[1] + word[3]) / 2 <= bottom + 1]
            expected = doc[entry["target"]].get_label()
            if numbers != [expected]:
                issues.append({"kind": "toc_page_number", "page": entry["page"] + 1,
                               "printed": numbers, "expected": expected})

        for position, (level, title, page_number) in enumerate(outline):
            # Merged PDFs can have logical section bookmarks without a printed
            # section heading. Printed Pandoc TOCs must match every heading.
            has_children = position + 1 < len(outline) and outline[position + 1][0] > level
            if not 1 <= page_number <= len(doc):
                issues.append({"kind": "invalid_bookmark", "title": title})
            elif (expectations.get("requireToc") or not has_children) and not contains_text(title, texts[page_number - 1]):
                issues.append({"kind": "bookmark_title", "title": title, "page": page_number})
            if level <= 2 and page_number > 0:
                preview_pages.add(page_number - 1)
        body_text = "\n".join(text for i, text in enumerate(texts) if i not in toc_pages)
        full_text = "\n".join(texts)
        found_titles = [title for title in expectations.get("candidateTitles", [])
                        if contains_text(title, body_text)]
        for snippet in expectations.get("bodySnippets", []):
            if not contains_text(snippet, body_text):
                issues.append({"kind": "missing_body_content", "snippet": snippet})
        for title in expectations.get("articleTitles", []):
            matches = [(i, entry) for i, entry in enumerate(outline) if entry[1] == title and entry[0] == 2]
            if len(matches) != 1:
                issues.append({"kind": "article_bookmark", "title": title})
                continue
            position, entry = matches[0]
            start = entry[2] - 1
            end = next((item[2] - 1 for item in outline[position + 1:] if item[0] <= 2), len(doc))
            article_text = compact("\n".join(texts[start:end]))
            for _, heading, _ in outline:
                article_text = article_text.replace(compact(heading), "")
            if not re.sub(r"[\W\d_]+", "", article_text) and not any(doc[i].get_image_info() for i in range(start, end)):
                issues.append({"kind": "empty_article_body", "title": title, "page": start + 1})
        for title in expectations.get("titles", []):
            if not contains_text(title, full_text):
                issues.append({"kind": "missing_title", "title": title})
        for title in expectations.get("groups", []):
            if title not in [entry[1] for entry in outline if entry[0] == 1]:
                issues.append({"kind": "missing_group", "title": title})
        if expectations.get("requireToc"):
            if not outline or len(toc_pages) < expectations.get("minTocPages", 1):
                issues.append({"kind": "missing_toc"})
            if list(toc_links) != [destination_key(entry[3]) for entry in detailed_outline]:
                issues.append({"kind": "toc_targets", "links": len(toc_links), "bookmarks": len(outline)})
        if expectations.get("requireImages") and not any(page.get_image_info() for page in doc):
            issues.append({"kind": "missing_image"})
        for required_font in expectations.get("requiredFonts", []):
            expected_font = required_font.get("name") if isinstance(required_font, dict) else required_font
            embedded_names = (required_font.get("embeddedNames", [expected_font])
                              if isinstance(required_font, dict) else [expected_font])
            if not any(font_matches(embedded_name, actual_font)
                       for embedded_name in embedded_names for actual_font in used_fonts):
                issues.append({"kind": "missing_font", "font": expected_font})
        for snippet in expectations.get("previewSnippets", []):
            preview_pages.update(index for index, text in enumerate(texts) if contains_text(snippet, text))
        # Keep diagnostics bounded even when one defect affects an entire book.
        issue_pages = sorted({issue["page"] - 1 for issue in issues if "page" in issue})
        preview_pages.update(issue_pages[:12])
        return {
            "pdf": str(Path(pdf_path).resolve()), "pages": len(doc),
            "outlineEntries": len(outline), "tocPages": [i + 1 for i in toc_pages],
            "tocLinks": len(toc_links), "tocAnnotations": toc_annotations, "issues": issues, "passed": not issues,
            "previewPages": [i + 1 for i in sorted(preview_pages) if 0 <= i < len(doc)],
            "visualReview": "required",
            "foundTitles": found_titles,
            "fonts": sorted(used_fonts),
            "layout": expectations.get("layout"),
            "previewKinds": expectations.get("previewKinds", []),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--expectations", type=Path)
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    expectations = json.loads(args.expectations.read_text()) if args.expectations else {}
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = inspect_pdf(args.pdf, expectations)
    report_path = args.report_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if args.render:
        # Reusing a report directory must not leave previews from an older PDF.
        for previous in args.report_dir.glob("page-*.png"):
            if re.fullmatch(r"page-\d+\.png", previous.name):
                previous.unlink()
        for page in report["previewPages"]:
            subprocess.run([
                "pdftoppm", "-f", str(page), "-l", str(page), "-singlefile", "-r", "110", "-png",
                str(args.pdf), str(args.report_dir / f"page-{page:03d}"),
            ], check=True, timeout=60, capture_output=True)
    print(json.dumps({"passed": report["passed"], "pages": report["pages"],
                      "foundTitles": report["foundTitles"],
                      "issues": len(report["issues"]), "report": str(report_path)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
