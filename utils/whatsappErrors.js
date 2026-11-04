/*
 * Meta's WhatsApp error codes, said the way an office manager would want to
 * hear them. Used wherever an error reaches a screen: a send that Meta refused
 * (GraphError.code) and a message the webhook later reported as failed
 * (statusErrors[0].code). An unknown code keeps Meta's own wording.
 *
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const WINDOW_CLOSED_CODE = 131047

const PLAIN = {
  // The 24-hour rule
  131047: 'More than 24 hours have passed since this contact last wrote, so WhatsApp only allows an approved template now. A free-text reply opens again once they message the academy.',
  // Billing
  131042: "WhatsApp couldn't charge for this message. Add a payment method to the academy's Meta business account (Business settings → Payments), then try again.",
  // The recipient
  131026: "This number couldn't receive the message. It may not be on WhatsApp, or the person may need to update their WhatsApp app.",
  131030: "This number isn't on the test number's allowed list. Add it in Meta's API Setup, or connect the academy's own number.",
  131049: 'WhatsApp held this message back so the person does not get too many business messages. Try again later, or wait for them to message first.',
  131050: 'This person has stopped marketing messages from businesses, so only reminders and updates can reach them.',
  131051: "WhatsApp doesn't support this kind of message.",
  131052: "The file in this message couldn't be downloaded.",
  131053: "The file couldn't be sent. Try a smaller photo, or a PDF instead.",
  // Templates
  132000: "The template's blanks didn't match what was filled in. Check every blank has a value.",
  132001: "That template doesn't exist in this language, or isn't approved yet.",
  132005: 'The filled-in template is too long. Shorten the values in the blanks.',
  132007: "WhatsApp didn't accept the text in this template.",
  132012: "A blank in this template was filled with the wrong kind of value.",
  132015: 'This template is paused by WhatsApp because people reported or ignored it. Edit it or use another one.',
  132016: 'This template has been turned off by WhatsApp. Use another one.',
  // Speed and limits
  130429: 'Too many messages too quickly. Wait a minute and try again.',
  131056: 'Too many messages to this person in a short time. Wait a minute and try again.',
  131048: 'WhatsApp is limiting the academy number because recent messages were blocked or reported. Send only messages people expect for a while.',
  // The connection itself
  190: 'The connection to WhatsApp has expired. Reconnect the number on the WhatsApp page.',
  131031: 'WhatsApp has locked the academy number. Check the business account in Meta Business Suite.',
  133010: "The academy number isn't fully registered with WhatsApp yet. Reconnect it on the WhatsApp page.",
  368: 'WhatsApp has temporarily blocked the academy number for a policy issue. Check Meta Business Suite for the details.',
}

/** A plain sentence for a Meta error code, or the fallback (Meta's own text). */
export function plainWhatsappError(code, fallback = '') {
  return PLAIN[Number(code)] || fallback || 'WhatsApp could not deliver this message.'
}

/** For a stored failed message: the first status error, in plain words. */
export function plainFailure(message) {
  const e = message?.statusErrors?.[0]
  if (!e) return 'Not delivered'
  return plainWhatsappError(e.code, e.title || e.details)
}
