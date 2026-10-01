import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

import pymupdf

spec = importlib.util.spec_from_file_location(
    "verify_pdf", Path(__file__).resolve().parents[2] / "src/python/verify_pdf.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerifyPdfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "fixture.pdf"

    def create_pdf(self, printed="1", overflow=False, empty=False):
        with pymupdf.open() as doc:
            doc.new_page(width=300, height=400)
            doc.new_page(width=300, height=400)
            doc[0].insert_text((30, 70), "Contents")
            doc[0].insert_text((30, 100), "Guide")
            doc[0].insert_text((260, 100), printed)
            doc[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(30, 86, 280, 103),
                                "page": 1, "to": pymupdf.Point(0, 70)})
            if not empty:
                doc[1].insert_text((30, 70), "Guide")
            if overflow:
                doc[1].insert_text((290, 150), "Long text outside the page")
            doc.set_toc([[1, "Guide", 2, {"kind": pymupdf.LINK_GOTO, "page": 1, "to": pymupdf.Point(0, 70)}]])
            doc.set_page_labels([{"startpage": 0, "style": "r"}, {"startpage": 1, "style": "D"}])
            doc.save(self.path)

    def test_valid_bookmarks_labels_and_titles(self):
        self.create_pdf()
        result = verify.inspect_pdf(self.path, {"requireToc": True, "titles": ["Guide"]})
        self.assertTrue(result["passed"], result["issues"])
        self.assertEqual(result["tocPages"], [1])
        self.assertEqual(result["tocLinks"], 1)
        self.assertEqual(result["visualReview"], "required")

    def test_wrapped_toc_title_can_have_multiple_link_annotations(self):
        self.create_pdf()
        with pymupdf.open(self.path) as doc:
            doc[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(30, 76, 100, 86),
                                "page": 1, "to": pymupdf.Point(0, 70)})
            doc.saveIncr()
        result = verify.inspect_pdf(self.path, {"requireToc": True})
        self.assertTrue(result["passed"], result["issues"])
        self.assertEqual(result["tocLinks"], 1)
        self.assertEqual(result["tocAnnotations"], 2)

    def test_printed_page_number_mismatch_is_fatal(self):
        self.create_pdf(printed="9")
        kinds = [issue["kind"] for issue in verify.inspect_pdf(self.path)["issues"]]
        self.assertIn("toc_page_number", kinds)

    def test_text_outside_page_is_detected_even_when_clipped(self):
        self.create_pdf(overflow=True)
        result = verify.inspect_pdf(self.path)
        self.assertIn("overflow", [issue["kind"] for issue in result["issues"]])

    def test_expected_structure_and_images_cannot_disappear(self):
        self.create_pdf()
        result = verify.inspect_pdf(self.path, {
            "titles": ["Missing title"], "groups": ["Missing group"],
            "requireToc": True, "minTocPages": 2, "requireImages": True,
        })
        self.assertEqual({issue["kind"] for issue in result["issues"]},
                         {"missing_title", "missing_group", "missing_toc", "missing_image"})

    def test_empty_body_and_wrong_bookmark_destination_are_detected(self):
        self.create_pdf(empty=True)
        kinds = [issue["kind"] for issue in verify.inspect_pdf(self.path)["issues"]]
        self.assertIn("empty_page", kinds)
        self.assertIn("bookmark_title", kinds)

    def test_corrupt_pdf_is_not_accepted(self):
        self.path.write_text("not a PDF")
        with self.assertRaises(pymupdf.FileDataError):
            verify.inspect_pdf(self.path)

    def test_profile_dimensions_and_vertical_margins_are_checked(self):
        self.create_pdf()
        result = verify.inspect_pdf(self.path, {"pageWidthPt": 200, "pageHeightPt": 400, "marginTopPt": 100})
        kinds = {issue["kind"] for issue in result["issues"]}
        self.assertIn("page_size", kinds)
        self.assertIn("overflow", kinds)

    def test_layout_furniture_zones_and_required_fonts_are_checked(self):
        self.create_pdf()
        with pymupdf.open(self.path) as doc:
            doc[1].insert_text((30, 20), "Running header", fontsize=8)
            doc.saveIncr()
        expectations = {
            "marginTopPt": 50,
            "headerZoneTopPt": 5,
            "headerZoneBottomPt": 30,
            "headerMaxFontSizePt": 9,
            "requiredFonts": [{"name": "Missing Serif", "embeddedNames": ["MissingSerif"]}],
            "layout": {"id": "reading-5x8", "version": "1.0.0", "fingerprint": "abc"},
        }
        result = verify.inspect_pdf(self.path, expectations)
        self.assertNotIn("overflow", [issue["kind"] for issue in result["issues"]])
        self.assertIn("missing_font", [issue["kind"] for issue in result["issues"]])
        self.assertEqual(result["layout"], expectations["layout"])

    def test_oversized_text_is_not_accepted_as_running_furniture(self):
        self.create_pdf()
        with pymupdf.open(self.path) as doc:
            doc[1].insert_text((30, 20), "Not a header", fontsize=12)
            doc.saveIncr()
        result = verify.inspect_pdf(self.path, {
            "marginTopPt": 50,
            "headerZoneTopPt": 5,
            "headerZoneBottomPt": 30,
            "headerMaxFontSizePt": 9,
        })
        self.assertIn("overflow", [issue["kind"] for issue in result["issues"]])

    def test_toc_title_does_not_prove_body_or_semantic_coverage(self):
        self.create_pdf(empty=True)
        result = verify.inspect_pdf(self.path, {"candidateTitles": ["Guide"], "bodySnippets": ["Guide"]})
        self.assertEqual(result["foundTitles"], [])
        self.assertIn("missing_body_content", {issue["kind"] for issue in result["issues"]})

    def test_heading_only_article_is_not_complete(self):
        self.create_pdf()
        with pymupdf.open(self.path) as doc:
            doc.set_toc([[1, "Collection", 2], [2, "Guide", 2]])
            doc.saveIncr()
        result = verify.inspect_pdf(self.path, {"articleTitles": ["Guide"]})
        self.assertIn("empty_article_body", {issue["kind"] for issue in result["issues"]})

    def test_text_matching_handles_discretionary_and_authored_hyphens(self):
        self.assertTrue(verify.contains_text("documentation", "docu-\nmentation"))
        self.assertTrue(verify.contains_text("set-up", "set-\nup"))
        self.assertFalse(verify.contains_text("documentation", "different content"))

    def test_text_matching_expands_typographic_ligatures(self):
        self.assertTrue(verify.contains_text("difficult tasks", "di\ufb00icult tasks"))
        self.assertTrue(verify.contains_text("first file", "\ufb01rst \ufb01le"))
        self.assertFalse(verify.contains_text("difficult", "di\ufb01cult"))

    def test_render_removes_stale_numbered_previews_but_preserves_other_files(self):
        self.create_pdf()
        report_dir = Path(self.temp.name) / "qa"
        report_dir.mkdir()
        (report_dir / "page-999.png").write_text("stale")
        (report_dir / "page-notes.png").write_text("keep")
        argv = ["verify_pdf", str(self.path), "--report-dir", str(report_dir), "--render"]
        with patch.object(sys, "argv", argv), patch.object(verify.subprocess, "run") as render:
            self.assertEqual(verify.main(), 0)
        self.assertFalse((report_dir / "page-999.png").exists())
        self.assertTrue((report_dir / "page-notes.png").exists())
        self.assertEqual(render.call_count, 2)


if __name__ == "__main__":
    unittest.main()
