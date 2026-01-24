// lib/email.ts
// Minimal Resend email helper with safe fallbacks.

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  replyTo?: string;
};

function hasEmailEnv() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({ to, subject, html, text, cc, replyTo }: SendArgs) {
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

export function makeInviteEmail(inviteUrl: string, shopId: number, role: string) {
  const subject = `You've been invited to MOS Maintenance (Shop #${shopId})`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2>You're invited</h2>
      <p>You've been invited to join Shop <b>#${shopId}</b> as <b>${role}</b>.</p>
      <p>Click below to complete your account setup.</p>
      <p><a href="${inviteUrl}" style="background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;display:inline-block">Accept Invite</a></p>
      <p>or copy/paste this URL:</p>
      <p><a href="${inviteUrl}">${inviteUrl}</a></p>
    </div>`;
  const text = `Accept your invite: ${inviteUrl}`;
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

export function makePendingBookingsReminderEmail(
  shopName: string,
  pendingCount: number,
  queueUrl: string
) {
  const subject = `${pendingCount} appointment${pendingCount === 1 ? "" : "s"} awaiting review - ${shopName}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Appointments Awaiting Review</h1>
      
      <p style="color:#4b5563;font-size:16px">
        <b>${shopName}</b> has <b style="color:#d97706">${pendingCount} pending appointment${pendingCount === 1 ? "" : "s"}</b> that need${pendingCount === 1 ? "s" : ""} your review.
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        Auto-booked appointments are waiting for staff approval before being sent to your shop schedule.
      </p>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${queueUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Review Appointments</a>
      </div>
      
      <div style="background:#fef3c7;border-radius:8px;padding:16px;margin:20px 0">
        <p style="color:#92400e;font-size:14px;margin:0">
          <b>Tip:</b> You can change the confirmation mode to "Automatic" in Auto Booking settings to skip the review step.
        </p>
      </div>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        MOS Tools - Smarter Maintenance for Auto Shops<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `${shopName} has ${pendingCount} pending appointment${pendingCount === 1 ? "" : "s"} awaiting review.\n\nReview them here: ${queueUrl}`;
  return { subject, html, text };
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

