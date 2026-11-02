/**
 * Give feedback: opens the person's own email app with a message to the author already started.
 * Nothing is sent from the app itself, it stays local-only: the email app sends it, and only when the person hits send.
 */
export const FEEDBACK_EMAIL = 'brett.hollifield@gmail.com'

/** The mailto link, with a subject and the browser it was sent from (handy for bug reports). */
export function feedbackUrl(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const subject = 'CADdy McCADFace feedback'
  const body = ['What happened, or what would you like to see?', '', '', '', '---', `Browser: ${ua}`].join('\n')
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function giveFeedback() {
  // the specs collect the link here: a headless browser has no email app to hand it to
  const caught = (window as unknown as { __e2eFeedback?: string[] }).__e2eFeedback
  if (caught) caught.push(feedbackUrl())
  else window.location.href = feedbackUrl()
}
