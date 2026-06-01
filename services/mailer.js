import nodemailer from 'nodemailer'

let transporter = null

function getTransporter() {
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })

  return transporter
}

export async function notifyAdmin({ subject, html }) {
  try {
    const transport = getTransporter()
    await transport.sendMail({
      from: `"Hidaya Online" <${process.env.SMTP_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject,
      html,
    })
    console.log(`Email sent: ${subject}`)
  } catch (err) {
    console.error('Email send failed:', err.message)
  }
}

export function enrollmentEmail(data) {
  return {
    subject: `New ${data.source === 'contact' ? 'Contact' : 'Enrollment'} — ${data.name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px">
        <div style="background:#0C3B2E;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px">Hidaya Online — New Submission</h2>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6b7280;width:100px">Source</td><td style="padding:8px 0;font-weight:600">${data.source}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Name</td><td style="padding:8px 0;font-weight:600">${data.name}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="padding:8px 0"><a href="mailto:${data.email}">${data.email}</a></td></tr>
            ${data.phone ? `<tr><td style="padding:8px 0;color:#6b7280">Phone</td><td style="padding:8px 0">${data.phone}</td></tr>` : ''}
            ${data.message ? `<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Message</td><td style="padding:8px 0">${data.message}</td></tr>` : ''}
          </table>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
          <p style="color:#9ca3af;font-size:12px;margin:0">Sent from hidaya.online</p>
        </div>
      </div>
    `,
  }
}

export function paymentEmail(data) {
  return {
    subject: `Payment ${data.status} — ${data.studentName} ($${data.amount})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px">
        <div style="background:${data.status === 'completed' ? '#059669' : '#dc2626'};padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px">Payment ${data.status.toUpperCase()}</h2>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6b7280;width:100px">Student</td><td style="padding:8px 0;font-weight:600">${data.studentName}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="padding:8px 0"><a href="mailto:${data.studentEmail}">${data.studentEmail}</a></td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Plan</td><td style="padding:8px 0">${data.plan}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Amount</td><td style="padding:8px 0;font-weight:700;font-size:18px">$${data.amount}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">Order ID</td><td style="padding:8px 0;font-family:monospace;font-size:13px">${data.gatewayOrderId || '—'}</td></tr>
          </table>
        </div>
      </div>
    `,
  }
}
