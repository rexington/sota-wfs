/**
 * WFS GetCapabilities / DescribeFeatureType / ExceptionReport XML.
 * Port of sota_wfs/capabilities.py.
 */
import { escapeXml } from "../xml/escape";
import type { LayerDef } from "../data/types";
import { qname } from "../data/types";

const NS_URI = "http://sota"; // namespace URI for the "sota" prefix, mirroring GeoServer's workspace URI

const OUTPUT_FORMATS = ["application/json", "json", "application/json; subtype=geojson"];

export interface LayerInfo {
  layer: LayerDef;
  bbox: [number, number, number, number];
}

export function capabilitiesXml(version: string, layers: LayerInfo[], baseUrl: string): string {
  return version.startsWith("1") ? capabilities110(layers, baseUrl) : capabilities200(layers, baseUrl);
}

function param(name: string, values: string[], ows10: boolean): string {
  let vals = values.map((v) => `<ows:Value>${escapeXml(v)}</ows:Value>`).join("");
  if (!ows10) vals = `<ows:AllowedValues>${vals}</ows:AllowedValues>`;
  return `<ows:Parameter name="${name}">${vals}</ows:Parameter>`;
}

function operationsMetadata(baseUrl: string, version: string): string {
  const href = escapeXml(`${baseUrl}/geoserver/wfs`, true);
  // OWS 1.0 (WFS 1.1.0) puts ows:Value directly inside ows:Parameter; the
  // ows:AllowedValues wrapper only exists in OWS 1.1 (WFS 2.0.0). CalTopo's
  // auto-configure parses the 1.1.0 document and rejects wrapped values.
  const ows10 = version.startsWith("1");

  const ops = (["GetCapabilities", "DescribeFeatureType", "GetFeature"] as const).map((op) => {
    const params: string[] = [];
    if (op === "GetCapabilities") {
      params.push(param("AcceptVersions", ["1.1.0", "2.0.0"], ows10));
    } else {
      if (op === "GetFeature") {
        // CalTopo's auto-configure reads GetFeature's parameters
        // positionally and needs outputFormat second, as GeoServer serves
        // it (resultType first).
        params.push(param("resultType", ["results", "hits"], ows10));
      }
      params.push(param("outputFormat", OUTPUT_FORMATS, ows10));
    }
    return (
      `<ows:Operation name="${op}">` +
      "<ows:DCP><ows:HTTP>" +
      `<ows:Get xlink:href="${href}"/>` +
      `<ows:Post xlink:href="${href}"/>` +
      `</ows:HTTP></ows:DCP>${params.join("")}</ows:Operation>`
    );
  });
  return `<ows:OperationsMetadata>${ops.join("")}</ows:OperationsMetadata>`;
}

function featureType110(info: LayerInfo): string {
  const [minx, miny, maxx, maxy] = info.bbox;
  const { layer } = info;
  return (
    "<FeatureType>" +
    `<Name>${escapeXml(qname(layer))}</Name>` +
    `<Title>${escapeXml(layer.title)}</Title>` +
    `<Abstract>${escapeXml(layer.abstract)}</Abstract>` +
    "<DefaultSRS>urn:ogc:def:crs:EPSG::4326</DefaultSRS>" +
    "<OutputFormats>" +
    OUTPUT_FORMATS.map((f) => `<Format>${escapeXml(f)}</Format>`).join("") +
    "</OutputFormats>" +
    "<ows:WGS84BoundingBox>" +
    `<ows:LowerCorner>${minx} ${miny}</ows:LowerCorner>` +
    `<ows:UpperCorner>${maxx} ${maxy}</ows:UpperCorner>` +
    "</ows:WGS84BoundingBox>" +
    "</FeatureType>"
  );
}

function capabilities110(layers: LayerInfo[], baseUrl: string): string {
  const fts = layers.map(featureType110).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<wfs:WFS_Capabilities version="1.1.0"' +
    ' xmlns:wfs="http://www.opengis.net/wfs"' +
    ' xmlns="http://www.opengis.net/wfs"' +
    ' xmlns:ows="http://www.opengis.net/ows"' +
    ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ' xmlns:ogc="http://www.opengis.net/ogc"' +
    ` xmlns:sota="${NS_URI}">` +
    "<ows:ServiceIdentification>" +
    "<ows:Title>SOTA WFS</ows:Title>" +
    "<ows:Abstract>Minimal WFS serving SOTA summits and Tesla Superchargers</ows:Abstract>" +
    "<ows:ServiceType>WFS</ows:ServiceType>" +
    "<ows:ServiceTypeVersion>1.1.0</ows:ServiceTypeVersion>" +
    "</ows:ServiceIdentification>" +
    operationsMetadata(baseUrl, "1.1.0") +
    `<FeatureTypeList><Operations><Operation>Query</Operation></Operations>${fts}</FeatureTypeList>` +
    "<ogc:Filter_Capabilities>" +
    "<ogc:Spatial_Capabilities>" +
    "<ogc:GeometryOperands><ogc:GeometryOperand>gml:Point</ogc:GeometryOperand><ogc:GeometryOperand>gml:Envelope</ogc:GeometryOperand></ogc:GeometryOperands>" +
    '<ogc:SpatialOperators><ogc:SpatialOperator name="BBOX"/></ogc:SpatialOperators>' +
    "</ogc:Spatial_Capabilities>" +
    "<ogc:Scalar_Capabilities><ogc:LogicalOperators/></ogc:Scalar_Capabilities>" +
    "<ogc:Id_Capabilities><ogc:FID/></ogc:Id_Capabilities>" +
    "</ogc:Filter_Capabilities>" +
    "</wfs:WFS_Capabilities>"
  );
}

function featureType200(info: LayerInfo): string {
  const [minx, miny, maxx, maxy] = info.bbox;
  const { layer } = info;
  return (
    "<FeatureType>" +
    `<Name>${escapeXml(qname(layer))}</Name>` +
    `<Title>${escapeXml(layer.title)}</Title>` +
    `<Abstract>${escapeXml(layer.abstract)}</Abstract>` +
    "<DefaultCRS>urn:ogc:def:crs:EPSG::4326</DefaultCRS>" +
    "<OutputFormats>" +
    OUTPUT_FORMATS.map((f) => `<Format>${escapeXml(f)}</Format>`).join("") +
    "</OutputFormats>" +
    "<ows:WGS84BoundingBox>" +
    `<ows:LowerCorner>${minx} ${miny}</ows:LowerCorner>` +
    `<ows:UpperCorner>${maxx} ${maxy}</ows:UpperCorner>` +
    "</ows:WGS84BoundingBox>" +
    "</FeatureType>"
  );
}

function capabilities200(layers: LayerInfo[], baseUrl: string): string {
  const fts = layers.map(featureType200).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<wfs:WFS_Capabilities version="2.0.0"' +
    ' xmlns:wfs="http://www.opengis.net/wfs/2.0"' +
    ' xmlns="http://www.opengis.net/wfs/2.0"' +
    ' xmlns:ows="http://www.opengis.net/ows/1.1"' +
    ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ' xmlns:fes="http://www.opengis.net/fes/2.0"' +
    ` xmlns:sota="${NS_URI}">` +
    "<ows:ServiceIdentification>" +
    "<ows:Title>SOTA WFS</ows:Title>" +
    "<ows:Abstract>Minimal WFS serving SOTA summits and Tesla Superchargers</ows:Abstract>" +
    "<ows:ServiceType>WFS</ows:ServiceType>" +
    "<ows:ServiceTypeVersion>2.0.0</ows:ServiceTypeVersion>" +
    "<ows:ServiceTypeVersion>1.1.0</ows:ServiceTypeVersion>" +
    "</ows:ServiceIdentification>" +
    operationsMetadata(baseUrl, "2.0.0") +
    `<FeatureTypeList>${fts}</FeatureTypeList>` +
    "<fes:Filter_Capabilities>" +
    "<fes:Spatial_Capabilities>" +
    "<fes:GeometryOperands>" +
    '<fes:GeometryOperand name="gml:Point"/><fes:GeometryOperand name="gml:Envelope"/>' +
    "</fes:GeometryOperands>" +
    '<fes:SpatialOperators><fes:SpatialOperator name="BBOX"/></fes:SpatialOperators>' +
    "</fes:Spatial_Capabilities>" +
    "</fes:Filter_Capabilities>" +
    "</wfs:WFS_Capabilities>"
  );
}

export function describeFeatureTypeXml(layer: LayerDef, columns: string[]): string {
  const elements = columns
    .map(
      (c) =>
        `<xsd:element maxOccurs="1" minOccurs="0" name="${escapeXml(c)}" nillable="true" type="xsd:string"/>`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"' +
    ' xmlns:gml="http://www.opengis.net/gml"' +
    ` xmlns:sota="${NS_URI}"` +
    ' elementFormDefault="qualified"' +
    ` targetNamespace="${NS_URI}">` +
    '<xsd:import namespace="http://www.opengis.net/gml"' +
    ' schemaLocation="http://schemas.opengis.net/gml/3.1.1/base/gml.xsd"/>' +
    `<xsd:complexType name="${escapeXml(layer.name)}Type">` +
    "<xsd:complexContent>" +
    '<xsd:extension base="gml:AbstractFeatureType">' +
    "<xsd:sequence>" +
    elements +
    '<xsd:element maxOccurs="1" minOccurs="0" name="the_geom" nillable="true" type="gml:PointPropertyType"/>' +
    "</xsd:sequence>" +
    "</xsd:extension>" +
    "</xsd:complexContent>" +
    "</xsd:complexType>" +
    `<xsd:element name="${escapeXml(layer.name)}" substitutionGroup="gml:_Feature" type="sota:${escapeXml(layer.name)}Type"/>` +
    "</xsd:schema>"
  );
}

export function exceptionXml(code: string, text: string, locator: string | null = null): string {
  const loc = locator ? ` locator="${escapeXml(locator, true)}"` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">' +
    `<ows:Exception exceptionCode="${escapeXml(code)}"${loc}>` +
    `<ows:ExceptionText>${escapeXml(text)}</ows:ExceptionText>` +
    "</ows:Exception>" +
    "</ows:ExceptionReport>"
  );
}
