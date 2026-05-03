// lib/email.ts
// Minimal Resend email helper with safe fallbacks.

import { getDb } from "./mongo";
import {
  getReviewStateForShopId,
  type GatedEmailKind,
} from "./shop-review";

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  replyTo?: string;
  // When provided, the helper looks up the shop's review state and
  // refuses to send any transactional email unless the shop has been
  // explicitly approved by a platform admin (task #252). Callers that
  // intentionally bypass the gate (platform admin <-> internal mail,
  // password resets to individual users, etc.) simply omit shopId.
  shopId?: number | string | null;
  emailKind?: GatedEmailKind;
};

export type SendEmailResult =
  | { ok: true; dev?: boolean }
  | {
      ok: false;
      suppressed: true;
      reason: "shop_not_approved" | "shop_not_found";
      reviewStatus?: string;
      autoFlagReasons?: string[];
    };

function hasEmailEnv() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  cc,
  replyTo,
  shopId,
  emailKind,
}: SendArgs): Promise<SendEmailResult> {
  // Gate: if the caller supplied a shopId, look up the review state and
  // suppress the send unless the shop is "approved". Logged with enough
  // structure that the admin can grep for shopId/emailKind later.
  if (shopId !== undefined && shopId !== null && shopId !== "") {
    try {
      const db = await getDb();
      const { found, fields } = await getReviewStateForShopId(db, shopId);
      if (!found || fields.reviewStatus !== "approved") {
        const reason = found ? "shop_not_approved" : "shop_not_found";
        console.warn("[email:SUPPRESSED]", {
          shopId,
          emailKind: emailKind || null,
          reviewStatus: fields.reviewStatus,
          autoFlagReasons: fields.autoFlagReasons,
          to,
          subject,
          reason,
        });
        return {
          ok: false,
          suppressed: true,
          reason,
          reviewStatus: fields.reviewStatus,
          autoFlagReasons: fields.autoFlagReasons,
        };
      }
    } catch (err: any) {
      // Fail closed: if we can't look up review state, don't accidentally
      // spam an unreviewed shop. Surface the error so the cron / webhook
      // caller can record it.
      console.error("[email:GATE-LOOKUP-FAILED]", {
        shopId,
        emailKind: emailKind || null,
        error: err?.message,
      });
      return {
        ok: false,
        suppressed: true,
        reason: "shop_not_approved",
        reviewStatus: "pending",
        autoFlagReasons: ["review_lookup_failed"],
      };
    }
  }

  if (!hasEmailEnv()) {
    // Dev fallback: log instead of sending
    console.log("[email:DEV-FALLBACK]", { to, subject, html, text, cc, replyTo });
    return { ok: true, dev: true };
  }

  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.EMAIL_FROM!;

  const payload: Record<string, any> = {
    from,
    to,
    subject,
    html,
    text,
  };
  
  if (cc) payload.cc = cc;
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${body || res.statusText}`);
  }

  return { ok: true };
}

export function makeResetEmail(resetUrl: string) {
  const subject = "Reset your MOS Maintenance password";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2>Reset your password</h2>
      <p>Click the button below to reset your password. This link expires in ~30 minutes.</p>
      <p><a href="${resetUrl}" style="background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;display:inline-block">Reset Password</a></p>
      <p>or copy/paste this URL:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
    </div>`;
  const text = `Reset your password: ${resetUrl}`;
  return { subject, html, text };
}

export function makeInviteEmail(inviteUrl: string, shopName: string, locationIdentifier: string | null, role: string) {
  const shopDisplay = locationIdentifier ? `${shopName} (${locationIdentifier})` : shopName;
  const subject = `You've been invited to MOS Tools - ${shopDisplay}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2>You're invited</h2>
      <p>You've been invited to join <b>${shopDisplay}</b> as <b>${role}</b>.</p>
      <p>Click below to complete your account setup.</p>
      <p><a href="${inviteUrl}" style="background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;display:inline-block">Accept Invite</a></p>
      <p>or copy/paste this URL:</p>
      <p><a href="${inviteUrl}">${inviteUrl}</a></p>
    </div>`;
  const text = `You've been invited to join ${shopDisplay} as ${role}. Accept your invite: ${inviteUrl}`;
  return { subject, html, text };
}

export function makeProtractorApiRequestEmail(shopName: string, shopLocation: string, ownerEmail: string) {
  const subject = `${shopName} - API Access Request`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
      <p>Support,</p>
      
      <p>Please enable the My Oil Sticker API for <b>${shopName}</b> in ${shopLocation}. Owner is cc'd here.</p>
      
      <p>Also, in the actions please ensure <b>UpdateWorkOrderLine</b> and <b>UpdateWorkOrderPackage</b> are enabled and set to "Yes".</p>
      
      <p>Thank you,<br/>
      MOS Tools Team<br/>
      <a href="mailto:support@mos.tools">support@mos.tools</a><br/>
      <a href="https://mos.tools">mos.tools</a></p>
    </div>`;
  const text = `Support,

Please enable the My Oil Sticker API for ${shopName} in ${shopLocation}. Owner is cc'd here.

Also, in the actions please ensure UpdateWorkOrderLine and UpdateWorkOrderPackage are enabled and set to "Yes".

Thank you,
MOS Tools Team
support@mos.tools
mos.tools`;
  return { subject, html, text, to: "support@protractor.com", cc: ownerEmail };
}

export function makeTekmetricSetupEmail(shopName: string, ownerEmail: string) {
  const chromeExtensionUrl = "https://chromewebstore.google.com/detail/mos-tools/gkcehigbdlhjacjbgiffnlfhdnghlknd";
  const subject = `${shopName} - Tekmetric Integration Setup Instructions`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Tekmetric Integration Setup</h1>
      
      <p style="color:#4b5563;font-size:16px">
        Hello! Here are the steps to complete your MOS Tools integration with Tekmetric for <b>${shopName}</b>:
      </p>
      
      <h2 style="color:#1f2937;font-size:18px;margin-top:24px">Step 1: Enable the Integration in Tekmetric</h2>
      <ol style="color:#4b5563;font-size:16px;padding-left:20px">
        <li>Log in to your Tekmetric account</li>
        <li>Go to <b>Settings</b> → <b>Integrations</b></li>
        <li>Find <b>"My Oil Sticker"</b> in the list</li>
        <li>Click to enable the integration</li>
      </ol>
      
      <h2 style="color:#1f2937;font-size:18px;margin-top:24px">Step 2: Install the Chrome Extension</h2>
      <p style="color:#4b5563;font-size:16px">
        The MOS Tools Chrome extension adds maintenance plans and job history search directly inside Tekmetric.
      </p>
      
      <div style="text-align:center;margin:24px 0">
        <a href="${chromeExtensionUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Install Chrome Extension</a>
      </div>
      
      <p style="color:#6b7280;font-size:14px">
        Or copy this link: <a href="${chromeExtensionUrl}" style="color:#2563eb">${chromeExtensionUrl}</a>
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#4b5563;font-size:16px">
        Need help? Reply to this email or reach out to <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <p style="color:#9ca3af;font-size:14px;text-align:center;margin-top:30px">
        MOS Tools - Smarter Maintenance for Auto Shops<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `Tekmetric Integration Setup for ${shopName}

Step 1: Enable the Integration in Tekmetric
1. Log in to your Tekmetric account
2. Go to Settings → Integrations
3. Find "My Oil Sticker" in the list
4. Click to enable the integration

Step 2: Install the Chrome Extension
The MOS Tools Chrome extension adds maintenance plans and job history search directly inside Tekmetric.

Install here: ${chromeExtensionUrl}

Need help? Contact support@mos.tools`;
  return { subject, html, text, to: ownerEmail };
}

export function makeTicketCreatedEmail(ticketNumber: string, subject: string, category: string) {
  const emailSubject = `Support Ticket Created: ${ticketNumber}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#3b82f6;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Support Ticket Created</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>Your support ticket has been submitted successfully. Our team will review it and respond as soon as possible.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Category</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${category}</div>
        </div>
        <p style="margin-top:20px">You can view your ticket status and add comments in your dashboard.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Support</p>
    </div>`;
  const text = `Support Ticket Created: ${ticketNumber}\n\nSubject: ${subject}\nCategory: ${category}\n\nYou can view your ticket status in your dashboard.`;
  return { subject: emailSubject, html, text };
}

export function makeTicketUpdatedEmail(ticketNumber: string, subject: string, status: string, message?: string) {
  const emailSubject = `Ticket Updated: ${ticketNumber}`;
  const statusColors: Record<string, string> = {
    'open': 'background:#dbeafe;color:#1d4ed8',
    'in progress': 'background:#fef3c7;color:#92400e',
    'resolved': 'background:#d1fae5;color:#065f46',
    'closed': 'background:#f1f5f9;color:#475569',
  };
  const statusStyle = statusColors[status.toLowerCase()] || 'background:#f1f5f9;color:#475569';
  
  const messageHtml = message ? `
    <div style="background:white;padding:15px;border-left:4px solid #3b82f6;border-radius:4px;margin:15px 0">
      <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase;margin-bottom:8px">New Message</div>
      <div style="white-space:pre-wrap">${message}</div>
    </div>
  ` : '';
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#8b5cf6;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Ticket Updated</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>There's been an update to your support ticket.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Status</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">
            <span style="${statusStyle};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${status}</span>
          </div>
        </div>
        ${messageHtml}
        <p style="margin-top:20px">Log in to your dashboard to view the full ticket details and respond.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Support</p>
    </div>`;
  const text = `Ticket Updated: ${ticketNumber}\n\nSubject: ${subject}\nStatus: ${status}${message ? `\n\nNew Message:\n${message}` : ''}\n\nLog in to your dashboard to view details.`;
  return { subject: emailSubject, html, text };
}

export function makeNewTicketAdminEmail(ticketNumber: string, subject: string, category: string, priority: string, shopName: string) {
  const emailSubject = `New Support Ticket: ${ticketNumber} - ${subject}`;
  const priorityColors: Record<string, string> = {
    'urgent': 'background:#fee2e2;color:#dc2626',
    'high': 'background:#fed7aa;color:#ea580c',
    'medium': 'background:#fef3c7;color:#ca8a04',
    'low': 'background:#d1fae5;color:#059669',
  };
  const priorityStyle = priorityColors[priority.toLowerCase()] || 'background:#fef3c7;color:#ca8a04';
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">New Support Ticket</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>A new support ticket has been submitted and requires attention.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Shop</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${shopName}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Category</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${category}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Priority</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">
            <span style="${priorityStyle};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${priority}</span>
          </div>
        </div>
        <p style="margin-top:20px">Log in to the Platform Admin panel to review and respond to this ticket.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Platform</p>
    </div>`;
  const text = `New Support Ticket: ${ticketNumber}\n\nShop: ${shopName}\nSubject: ${subject}\nCategory: ${category}\nPriority: ${priority}\n\nLog in to Platform Admin to respond.`;
  return { subject: emailSubject, html, text };
}

export function makeWelcomeEmail(shopName: string, loginUrl: string) {
  const subject = `Welcome to MOS Tools!`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Welcome to MOS Tools!</h1>
      
      <p style="color:#4b5563;font-size:16px">
        Thank you for signing up <b>${shopName}</b> with MOS Tools. Your account is ready to go!
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        With MOS Tools, you can:
      </p>
      
      <ul style="color:#4b5563;font-size:16px;padding-left:20px">
        <li>Get AI-powered maintenance recommendations for every vehicle</li>
        <li>Search job history across your shop (or enterprise)</li>
        <li>Track services and build customer trust</li>
        <li>Integrate with Tekmetric, Protractor, AutoFlow, and more</li>
      </ul>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Go to Dashboard</a>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        Need help getting started? Reply to this email or reach out to <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        MOS Tools - Smarter Maintenance for Auto Shops<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `Welcome to MOS Tools!\n\nThank you for signing up ${shopName}. Your account is ready.\n\nLog in: ${loginUrl}\n\nNeed help? Contact support@mos.tools`;
  return { subject, html, text };
}

export function makeCredentialsWelcomeEmail(
  shopName: string,
  email: string,
  tempPassword: string,
  loginUrl: string,
  chromeExtensionUrl: string = "https://chromewebstore.google.com/detail/mos-tools/gkcehigbdlhjacjbgiffnlfhdnghlknd",
  trialInfo?: { trialDays: number; trialEndsAt: Date | string }
) {
  const trialEndsAtDate = trialInfo?.trialEndsAt
    ? (trialInfo.trialEndsAt instanceof Date ? trialInfo.trialEndsAt : new Date(trialInfo.trialEndsAt))
    : null;
  const trialEndsLabel = trialEndsAtDate
    ? trialEndsAtDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  const trialBlockHtml = trialInfo && trialEndsLabel
    ? `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:20px;margin:24px 0">
        <h2 style="color:#92400e;font-size:16px;margin:0 0 8px 0">Your ${trialInfo.trialDays}-Day Trial Has Started</h2>
        <p style="color:#78350f;font-size:15px;margin:0 0 12px 0">
          Your trial runs through <b>${trialEndsLabel}</b>. To keep service uninterrupted when your trial ends, please add a payment method on your first login — you'll be prompted automatically and won't be charged until your trial converts.
        </p>
      </div>`
    : "";
  const trialBlockText = trialInfo && trialEndsLabel
    ? `\n\nYour ${trialInfo.trialDays}-day trial runs through ${trialEndsLabel}. Add a payment method on your first login so service continues without interruption when the trial ends. You won't be charged until the trial converts.\n`
    : "";
  const subject = `Your MOS Tools Login Credentials — ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Welcome to MOS Tools!</h1>
      
      <p style="color:#4b5563;font-size:16px">
        Thank you for signing up <b>${shopName}</b> with MOS Tools. Your account has been created and is ready to go!
      </p>
      
      <div style="background:#f0f9ff;border:1px solid #bfdbfe;border-radius:8px;padding:20px;margin:24px 0">
        <h2 style="color:#1e40af;font-size:16px;margin:0 0 12px 0">Your Login Credentials</h2>
        <p style="color:#1f2937;font-size:16px;margin:4px 0"><b>Email:</b> ${email}</p>
        <p style="color:#1f2937;font-size:16px;margin:4px 0"><b>Temporary Password:</b> <code style="background:#e0e7ff;padding:2px 8px;border-radius:4px;font-size:15px">${tempPassword}</code></p>
        <p style="color:#dc2626;font-size:14px;margin:12px 0 0 0">Please change your password after your first login.</p>
      </div>
      ${trialBlockHtml}
      
      <p style="color:#4b5563;font-size:16px">
        These credentials work for both:
      </p>
      
      <ul style="color:#4b5563;font-size:16px;padding-left:20px">
        <li><b>MOS Tools Web Dashboard</b> — manage stickers, maintenance plans, and shop settings</li>
        <li><b>Detect Dog Chrome Extension</b> — maintenance intelligence inside your shop management system</li>
      </ul>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Log In to Dashboard</a>
      </div>
      
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:24px 0">
        <h3 style="color:#1f2937;font-size:15px;margin:0 0 8px 0">Install the Chrome Extension</h3>
        <p style="color:#4b5563;font-size:14px;margin:0">
          Get Detect Dog for your browser to access maintenance plans directly inside Tekmetric, Shop-Ware, or AutoFlow.
        </p>
        <p style="margin:8px 0 0 0"><a href="${chromeExtensionUrl}" style="color:#2563eb;font-size:14px">Install from Chrome Web Store →</a></p>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        Need help getting started? Reply to this email or reach out to <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        MOS Tools - The Most Intelligent Oil Sticker on the Planet<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `Welcome to MOS Tools!\n\nYour account for ${shopName} has been created.\n\nLogin Credentials:\nEmail: ${email}\nTemporary Password: ${tempPassword}\n\nThese work for both the web dashboard and the Detect Dog Chrome extension.\n\nLog in: ${loginUrl}\nInstall Chrome Extension: ${chromeExtensionUrl}\n\nPlease change your password after your first login.${trialBlockText}\n\nNeed help? Contact support@mos.tools`;
  return { subject, html, text };
}

export function makeAnnouncementEmail(title: string, message: string, priority: "info" | "warning" | "critical") {
  const priorityColors = {
    info: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", label: "Information" },
    warning: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", label: "Important Notice" },
    critical: { bg: "#fee2e2", border: "#dc2626", text: "#991b1b", label: "Critical Alert" },
  };
  const colors = priorityColors[priority];
  
  const subject = priority === "critical" 
    ? `[CRITICAL] ${title}`
    : priority === "warning"
    ? `[IMPORTANT] ${title}`
    : title;
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:${colors.bg};border-left:4px solid ${colors.border};padding:16px;border-radius:4px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:${colors.text};text-transform:uppercase;margin-bottom:4px">${colors.label}</div>
        <h1 style="color:#1f2937;font-size:20px;margin:0">${title}</h1>
      </div>
      
      <div style="color:#4b5563;font-size:16px;white-space:pre-wrap">${message}</div>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        This is an automated message from MOS Tools<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `[${colors.label}] ${title}\n\n${message}\n\n---\nThis is an automated message from MOS Tools`;
  return { subject, html, text };
}

export async function sendAnnouncementEmails(
  emails: string[],
  title: string,
  message: string,
  priority: "info" | "warning" | "critical"
): Promise<number> {
  if (!hasEmailEnv()) {
    console.log("[email:DEV-FALLBACK] Would send announcement to:", emails.length, "recipients");
    return emails.length;
  }

  const { subject, html, text } = makeAnnouncementEmail(title, message, priority);
  let sent = 0;
  
  const batchSize = 50;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((email) => sendEmail({ to: email, subject, html, text }))
    );
    sent += results.filter((r) => r.status === "fulfilled").length;
  }

  return sent;
}

export function makePaymentFailedEmail(shopName: string, updatePaymentUrl: string, gracePeriodEndsAt: Date) {
  const daysRemaining = Math.ceil((gracePeriodEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const endDateStr = gracePeriodEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  
  const subject = `[Action Required] Payment failed for ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#92400e;font-size:20px;margin:0">Payment Failed</h1>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        We were unable to process the payment for <b>${shopName}</b>.
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        Your account will continue to work normally for <b>${daysRemaining} more days</b> (until ${endDateStr}). 
        Please update your payment method to avoid any interruption in service.
      </p>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${updatePaymentUrl}" style="background:#f59e0b;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Update Payment Method</a>
      </div>
      
      <p style="color:#4b5563;font-size:14px">
        If you believe this is an error or need assistance, please contact <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Payment Failed for ${shopName}\n\nWe couldn't process your payment. Your account will work for ${daysRemaining} more days (until ${endDateStr}).\n\nUpdate payment: ${updatePaymentUrl}\n\nContact support@mos.tools if you need help.`;
  return { subject, html, text };
}

export function makeGraceReminderEmail(shopName: string, updatePaymentUrl: string, daysRemaining: number) {
  const subject = `[Reminder] ${daysRemaining} days left to update payment - ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#92400e;font-size:20px;margin:0">Payment Reminder</h1>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        This is a reminder that payment for <b>${shopName}</b> is still pending.
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        You have <b>${daysRemaining} days remaining</b> to update your payment method before your account features are temporarily disabled.
      </p>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${updatePaymentUrl}" style="background:#f59e0b;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Update Payment Method</a>
      </div>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Payment Reminder for ${shopName}\n\n${daysRemaining} days left to update your payment method.\n\nUpdate payment: ${updatePaymentUrl}`;
  return { subject, html, text };
}

export function makeAccountSuspendedEmail(shopName: string, updatePaymentUrl: string) {
  const subject = `[URGENT] Account suspended - ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#991b1b;font-size:20px;margin:0">Account Suspended</h1>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        The account for <b>${shopName}</b> has been temporarily suspended due to an unpaid balance.
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        Your data is safe and your account will be fully restored once payment is received. 
        In the meantime, you have read-only access to your dashboard.
      </p>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${updatePaymentUrl}" style="background:#dc2626;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Update Payment Now</a>
      </div>
      
      <p style="color:#4b5563;font-size:14px">
        Need help? Contact <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Account Suspended - ${shopName}\n\nYour account has been suspended due to an unpaid balance. Your data is safe.\n\nUpdate payment: ${updatePaymentUrl}\n\nContact support@mos.tools for help.`;
  return { subject, html, text };
}

export function makePaymentRecoveredEmail(shopName: string, loginUrl: string) {
  const subject = `Welcome back! Payment received - ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:#dcfce7;border-left:4px solid #22c55e;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#166534;font-size:20px;margin:0">Payment Received</h1>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        Great news! We've received your payment for <b>${shopName}</b>.
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        Your account is now fully active and all features have been restored. Thank you for your continued business!
      </p>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${loginUrl}" style="background:#22c55e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Go to Dashboard</a>
      </div>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Payment Received - ${shopName}\n\nYour payment has been received and your account is fully active.\n\nGo to dashboard: ${loginUrl}`;
  return { subject, html, text };
}


export function makeTrialConversionPaymentFailedEmail(
  shopName: string,
  updatePaymentUrl: string,
  attemptsRemaining: number,
) {
  const remainingLabel =
    attemptsRemaining > 0
      ? `We'll automatically retry the charge ${attemptsRemaining} more ${
          attemptsRemaining === 1 ? "time" : "times"
        } before your dashboard is suspended.`
      : `This was the last automatic retry — your dashboard will be suspended shortly if payment isn't updated.`;
  const subject = `[Action Required] Trial conversion payment failed — ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#92400e;font-size:20px;margin:0">Trial conversion payment failed</h1>
      </div>
      <p style="color:#4b5563;font-size:16px">
        Your MOS Tools trial for <b>${shopName}</b> just ended and we tried to charge your card on file
        to start your subscription, but the payment was declined (this can happen for an expired card,
        insufficient funds, or a bank security challenge).
      </p>
      <p style="color:#4b5563;font-size:16px">${remainingLabel}</p>
      <div style="text-align:center;margin:30px 0">
        <a href="${updatePaymentUrl}" style="background:#f59e0b;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Update Payment Method</a>
      </div>
      <p style="color:#4b5563;font-size:14px">
        Need a hand? Reply to this email or contact <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Trial conversion payment failed for ${shopName}.\n\nWe tried to charge your card on file to start your subscription, but the payment was declined. ${remainingLabel}\n\nUpdate payment: ${updatePaymentUrl}\n\nContact support@mos.tools if you need help.`;
  return { subject, html, text };
}

export function makeTrialConversionSuspendedEmail(
  shopName: string,
  updatePaymentUrl: string,
  ownerFacing: boolean = true,
) {
  const subject = ownerFacing
    ? `[URGENT] Subscription suspended — ${shopName}`
    : `[Platform] Trial conversion suspended after retries — ${shopName}`;
  const html = ownerFacing
    ? `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:16px;border-radius:4px;margin-bottom:20px">
        <h1 style="color:#991b1b;font-size:20px;margin:0">Subscription suspended</h1>
      </div>
      <p style="color:#4b5563;font-size:16px">
        We weren't able to collect payment on your subscription for <b>${shopName}</b> after several
        automatic retries, so we've temporarily suspended the dashboard. Your data is safe.
      </p>
      <p style="color:#4b5563;font-size:16px">
        Update your payment method below and your account will be restored as soon as the next charge succeeds.
      </p>
      <div style="text-align:center;margin:30px 0">
        <a href="${updatePaymentUrl}" style="background:#dc2626;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Update Payment Now</a>
      </div>
      <p style="color:#4b5563;font-size:14px">
        Need help? Contact <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`
    : `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1f2937">Trial conversion suspended after retries</h2>
      <p>Shop <b>${shopName}</b> burned through its retry budget after the trial converted. The shop has been locked and the owner has been emailed.</p>
      <p><a href="${updatePaymentUrl}" style="color:#2563eb">Open shop in platform admin</a></p>
    </div>`;
  const text = ownerFacing
    ? `Subscription suspended for ${shopName}\n\nWe couldn't collect payment after several automatic retries. Your data is safe — update your payment method to restore access: ${updatePaymentUrl}\n\nContact support@mos.tools for help.`
    : `[Platform] Trial conversion for ${shopName} burned through its retry budget. Shop locked. Owner notified. Admin: ${updatePaymentUrl}`;
  return { subject, html, text };
}

export {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "./email-templates";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "./email-templates";

export type TrialReminderOverrides = {
  subject?: string;
  html?: string;
  text?: string;
};

function renderTrialReminderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  // First substitute every known {{key}}, then strip any remaining {{...}}
  // tokens (unknown placeholders) so they never leak to customers.
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), value);
  }
  out = out.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, "");
  return out;
}

function pickTemplate(override: string | undefined, fallback: string): string {
  if (typeof override !== "string" || override.trim().length === 0) return fallback;
  return override;
}

export function makeTrialReminderEmail(
  shopName: string,
  daysLeft: number,
  trialEndsAt: Date | string,
  addCardUrl: string,
  overrides?: TrialReminderOverrides,
) {
  const endsAtDate = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  const endsLabel = endsAtDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const dayWord = daysLeft === 1 ? "day" : "days";
  const vars: Record<string, string> = {
    shopName,
    daysLeft: String(daysLeft),
    dayWord,
    trialEndsAt: endsLabel,
    addCardUrl,
  };
  const subjectTpl = pickTemplate(overrides?.subject, DEFAULT_TRIAL_REMINDER_SUBJECT);
  const htmlTpl = pickTemplate(overrides?.html, DEFAULT_TRIAL_REMINDER_HTML);
  const textTpl = pickTemplate(overrides?.text, DEFAULT_TRIAL_REMINDER_TEXT);
  return {
    subject: renderTrialReminderTemplate(subjectTpl, vars),
    html: renderTrialReminderTemplate(htmlTpl, vars),
    text: renderTrialReminderTemplate(textTpl, vars),
  };
}

export function makeTrialConvertedEmail(
  shopName: string,
  planLabel: string,
  loginUrl: string,
) {
  const subject = `Your MOS Tools trial converted to ${planLabel} — ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#1f2937;font-size:22px">Welcome aboard!</h1>
      <p style="color:#4b5563;font-size:16px">
        Your trial for <b>${shopName}</b> has ended and your subscription on the <b>${planLabel}</b> plan is now active. Service continues uninterrupted, and your card on file has been used to start the subscription.
      </p>
      <div style="text-align:center;margin:24px 0">
        <a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Go to Dashboard</a>
      </div>
      <p style="color:#6b7280;font-size:14px">You can review or change your subscription anytime from Settings → Billing.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;
  const text = `Your MOS Tools trial for ${shopName} converted to the ${planLabel} plan. Service continues uninterrupted.\n\nDashboard: ${loginUrl}`;
  return { subject, html, text };
}

export function makeTrialSuspendedEmail(
  shopName: string,
  addCardUrl: string,
  ownerFacing: boolean = true,
) {
  const subject = ownerFacing
    ? `Your MOS Tools trial has ended — ${shopName}`
    : `[Platform] Trial suspended (no card) — ${shopName}`;
  const html = ownerFacing
    ? `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#991b1b;font-size:22px">Your trial has ended</h1>
      <p style="color:#4b5563;font-size:16px">
        Your MOS Tools trial for <b>${shopName}</b> has ended and we don't have a payment method on file. Your dashboard is temporarily locked, but your data is safe.
      </p>
      <p style="color:#4b5563;font-size:16px">Add a payment method below to restore full access.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${addCardUrl}" style="background:#dc2626;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Add Payment Method</a>
      </div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`
    : `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1f2937">Trial auto-suspended</h2>
      <p>Shop <b>${shopName}</b> trial ended with no card on file. The shop has been locked. Owner has been emailed.</p>
    </div>`;
  const text = ownerFacing
    ? `Your MOS Tools trial for ${shopName} has ended. Add a payment method to restore access: ${addCardUrl}`
    : `[Platform] Shop ${shopName} trial ended with no card on file. Shop locked. Owner notified.`;
  return { subject, html, text };
}
