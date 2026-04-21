import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { renderKeytagLegacy, renderKeytagDesigner } from "@/lib/canvas-renderer";
import { DesignerLayout, DesignerElement, DYMO_30252 } from "@/lib/keytag-designer-types";
import { resolvePaperSize } from "@/lib/keytag-paper-sizes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FontStyle {
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

interface KeytagConfig {
  enabled?: boolean;
  showLogo?: boolean;
  fontStyles?: {
    customerName?: FontStyle;
    vehicleInfo?: FontStyle;
    roNumber?: FontStyle;
    mileage?: FontStyle;
  };
  colors?: {
    text?: string;
    background?: string;
  };
  defaultSize?: string;
  designerLayout?: DesignerLayout;
}

interface KeytagRequest {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
  previewConfig?: KeytagConfig;
  designerLayout?: DesignerLayout;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    let body: KeytagRequest;
    try {
      body = await req.json();
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    
    if (!body || !body.customerName || !body.roNumber) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1 } }
    );

    const config: KeytagConfig = body.previewConfig || shop?.keytagConfig || {};
    const designerLayout = body.designerLayout || config.designerLayout;

    const paper = resolvePaperSize(designerLayout?.paperSize);

    let imageBuffer: Buffer;
    if (designerLayout) {
      console.log(`[Keytag Generate] Using designer layout (paper=${paper.id} ${paper.widthIn}"x${paper.heightIn}" @ ${paper.dpi}dpi)`);
      imageBuffer = await renderKeytagDesigner(
        {
          elements: designerLayout.elements,
          canvasWidth: designerLayout.canvasWidth || paper.designWidth,
          canvasHeight: designerLayout.canvasHeight || paper.designHeight,
          backgroundColor: designerLayout.backgroundColor || "#FFFFFF",
          textColor: designerLayout.textColor || "#000000",
        },
        {
          customerName: body.customerName,
          vehicleInfo: body.vehicleInfo,
          vin: body.vin,
          roNumber: body.roNumber,
          mileage: body.mileage,
        },
        paper.renderWidth,
        paper.renderHeight,
        2
      );
    } else {
      console.log("[Keytag Generate] Using legacy layout (canvas)");
      imageBuffer = await renderKeytagLegacy(
        { colors: config.colors },
        {
          customerName: body.customerName,
          vehicleInfo: body.vehicleInfo,
          vin: body.vin,
          roNumber: body.roNumber,
          mileage: body.mileage,
        },
        paper.renderWidth,
        paper.renderHeight,
        2
      );
    }

    return new NextResponse(new Uint8Array(imageBuffer), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="keytag-${body.roNumber}.png"`,
        'X-Keytag-Size': paper.id,
        'X-Keytag-Width': `${paper.widthIn.toFixed(3)}in`,
        'X-Keytag-Height': `${paper.heightIn.toFixed(3)}in`,
        'X-Keytag-DPI': String(paper.dpi),
      },
    });
  } catch (error) {
    console.error("Error generating keytag:", error);
    return NextResponse.json(
      { error: "Failed to generate keytag" },
      { status: 500 }
    );
  }
}
