"""Parse renderer fixtures with a real XML parser; stdin is a JSON array of SVGs."""
import json
import sys
import xml.etree.ElementTree as ET

fixtures = json.load(sys.stdin)
for svg in fixtures:
    root = ET.fromstring(svg)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert "viewBox" in root.attrib
    assert root.find("{http://www.w3.org/2000/svg}title") is not None
    assert all(not element.tag.endswith("}script") for element in root.iter())
    assert all(not attribute.lower().startswith("on") for element in root.iter() for attribute in element.attrib)
print(f"XML parser: {len(fixtures)} SVG fixtures passed")
