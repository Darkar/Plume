import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  buildInvitationReply,
  invitationPart,
  MAX_INVITATION_BYTES,
  parseInvitation,
} from '../src/calendar.js';
import { buildMime } from '../src/compose.js';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

/** Invitation au format de Google Agenda (fuseau IANA défini dans le fichier). */
const GOOGLE = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Paris:20261015T140000',
  'DTEND;TZID=Europe/Paris:20261015T150000',
  'DTSTAMP:20261001T080000Z',
  'ORGANIZER;CN=Alice Martin:mailto:alice@exemple.com',
  'UID:abc123@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alice Martin:mailto:alice@exemple.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Sacha:mailto:Sacha@Exemple.com',
  'SEQUENCE:2',
  'SUMMARY:Point projet\\, budget',
  'LOCATION:Salle 3',
  'DESCRIPTION:Ordre du jour :\\n- budget\\n- planning\\n<script>alert(1)</script>',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
]);

describe('parseInvitation', () => {
  it('lit une invitation Google : fuseau, participants, texte brut', () => {
    const invitation = parseInvitation(GOOGLE);
    expect(invitation).toMatchObject({
      method: 'REQUEST',
      uid: 'abc123@google.com',
      sequence: 2,
      summary: 'Point projet, budget',
      location: 'Salle 3',
      recurring: false,
      occurrence: false,
      cancelled: false,
      organizer: { name: 'Alice Martin', email: 'alice@exemple.com' },
      attendeeCount: 2,
    });
    // 14 h à Paris en octobre (heure d'été, UTC+2) = 12 h UTC.
    expect(invitation?.start).toEqual({ kind: 'utc', value: '2026-10-15T12:00:00.000Z' });
    expect(invitation?.end).toEqual({ kind: 'utc', value: '2026-10-15T13:00:00.000Z' });
    expect(invitation?.attendees).toEqual([
      { name: 'Alice Martin', email: 'alice@exemple.com', status: 'accepted' },
      { name: 'Sacha', email: 'sacha@exemple.com', status: 'needs-action' },
    ]);
    // Le texte reste du texte : aucune interprétation, retours à la ligne conservés.
    expect(invitation?.description).toBe(
      'Ordre du jour :\n- budget\n- planning\n<script>alert(1)</script>',
    );
  });

  it('fuseau Windows (Outlook) défini dans le fichier, et heure d’hiver', () => {
    const outlook = crlf([
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'PRODID:Microsoft Exchange Server 2010',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:Romance Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'ORGANIZER;CN="Bob":mailto:bob@exemple.org',
      'UID:040000008200E00074C5B7101A82E008',
      'SUMMARY;LANGUAGE=fr-FR:Revue mensuelle',
      'DTSTART;TZID=Romance Standard Time:20261210T090000',
      'DTEND;TZID=Romance Standard Time:20261210T093000',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=10',
      'DTSTAMP:20261001T080000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const invitation = parseInvitation(outlook);
    expect(invitation?.start).toEqual({ kind: 'utc', value: '2026-12-10T08:00:00.000Z' });
    expect(invitation?.recurring).toBe(true);
    expect(invitation?.organizer).toEqual({ name: 'Bob', email: 'bob@exemple.org' });
  });

  it('TZID IANA sans VTIMEZONE, journée entière, heure flottante et durée', () => {
    const event = (lines: string[]) =>
      parseInvitation(
        crlf([
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:x',
          ...lines,
          'END:VEVENT',
          'END:VCALENDAR',
        ]),
      );
    expect(event(['DTSTART;TZID=America/New_York:20260704T120000'])?.start).toEqual({
      kind: 'utc',
      value: '2026-07-04T16:00:00.000Z',
    });
    const allDay = event(['DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226']);
    expect(allDay?.start).toEqual({ kind: 'date', value: '2026-12-24' });
    expect(allDay?.end).toEqual({ kind: 'date', value: '2026-12-26' });
    // Sans méthode : simple publication (pas de réponse attendue).
    expect(allDay?.method).toBe('PUBLISH');
    expect(event(['DTSTART:20261024T183000'])?.start).toEqual({
      kind: 'floating',
      value: '2026-10-24T18:30:00',
    });
    // Fuseau inconnu et non défini : heure affichée telle quelle.
    expect(event(['DTSTART;TZID=Fuseau Inconnu:20261024T183000'])?.start?.kind).toBe('floating');
    expect(event(['DTSTART:20261024T183000Z', 'DURATION:PT1H30M'])?.end).toEqual({
      kind: 'utc',
      value: '2026-10-24T20:00:00.000Z',
    });
  });

  it('annulation, adresses invalides, caractères de contrôle', () => {
    const invitation = parseInvitation(
      crlf([
        'BEGIN:VCALENDAR',
        'METHOD:CANCEL',
        'BEGIN:VEVENT',
        'UID:y',
        `SUMMARY:Annul${String.fromCharCode(7)}é${String.fromCharCode(0x202e)}`,
        'ORGANIZER:javascript:alert(1)',
        'ATTENDEE:mailto:pas une adresse',
        'ATTENDEE;PARTSTAT=DECLINED:MAILTO:ok@exemple.com',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    expect(invitation).toMatchObject({
      method: 'CANCEL',
      cancelled: true,
      summary: 'Annul é',
      organizer: null,
      attendees: [{ name: '', email: 'ok@exemple.com', status: 'declined' }],
      attendeeCount: 2,
    });
  });

  it('refuse un contenu invalide, sans événement ou trop volumineux', () => {
    expect(parseInvitation('pas un calendrier')).toBeNull();
    expect(parseInvitation(crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']))).toBeNull();
    expect(
      parseInvitation(
        crlf([
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'SUMMARY:sans uid',
          'END:VEVENT',
          'END:VCALENDAR',
        ]),
      ),
    ).toBeNull();
    const huge = GOOGLE.replace('Salle 3', 'x'.repeat(MAX_INVITATION_BYTES));
    expect(parseInvitation(huge)).toBeNull();
  });

  it('limite le nombre de participants exposés', () => {
    const attendees = Array.from({ length: 150 }, (_, i) => `ATTENDEE:mailto:p${i}@exemple.com`);
    const invitation = parseInvitation(
      crlf([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:z',
        ...attendees,
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    expect(invitation?.attendees).toHaveLength(100);
    expect(invitation?.attendeeCount).toBe(150);
  });
});

describe('invitationPart', () => {
  const part = (contentType: string, filename: string, n: string) => ({
    part: n,
    filename,
    contentType,
    size: 1,
    contentId: null,
    inline: false,
  });
  it('préfère text/calendar, puis application/ics, puis un fichier .ics', () => {
    expect(
      invitationPart([
        part('application/pdf', 'a.pdf', '2'),
        part('application/ics', 'invite.ics', '3'),
        part('text/calendar', 'invitation.ics', '4'),
      ])?.part,
    ).toBe('4');
    expect(invitationPart([part('application/octet-stream', 'Invite.ICS', '2')])?.part).toBe('2');
    expect(invitationPart([part('application/pdf', 'a.pdf', '2')])).toBeNull();
  });
});

describe('buildInvitationReply', () => {
  const me = { name: 'Sacha "S" Martin', email: 'sacha@exemple.com' };
  const now = new Date('2026-10-02T09:00:00Z');

  it('produit une réponse iMIP minimale (RFC 5546)', () => {
    const reply = buildInvitationReply(GOOGLE, me, 'accepted', now);
    expect(reply?.organizer).toEqual({ name: 'Alice Martin', email: 'alice@exemple.com' });
    const calendar = new ICAL.Component(ICAL.parse(reply?.content ?? ''));
    expect(calendar.getFirstPropertyValue('method')).toBe('REPLY');
    const event = calendar.getFirstSubcomponent('vevent');
    expect(event?.getFirstPropertyValue('uid')).toBe('abc123@google.com');
    expect(event?.getFirstPropertyValue('sequence')).toBe(2);
    const attendees = event?.getAllProperties('attendee') ?? [];
    expect(attendees).toHaveLength(1);
    expect(attendees[0]?.getFirstValue()).toBe('mailto:sacha@exemple.com');
    expect(attendees[0]?.getParameter('partstat')).toBe('ACCEPTED');
    // Le nom (avec guillemets) reste un paramètre : pas d'injection de propriété.
    expect(attendees[0]?.getParameter('cn')).toBe(me.name);
    expect(event?.getFirstPropertyValue('organizer')).toBe('mailto:alice@exemple.com');
    // Rien d'autre n'est recopié de l'invitation reçue.
    expect(event?.hasProperty('description')).toBe(false);
    expect(event?.hasProperty('location')).toBe(false);
  });

  it('reprend l’occurrence visée et son fuseau', () => {
    const occurrence = GOOGLE.replace(
      'SEQUENCE:2',
      'SEQUENCE:2\r\nRECURRENCE-ID;TZID=Europe/Paris:20261015T140000',
    );
    const reply = buildInvitationReply(occurrence, me, 'declined', now);
    const calendar = new ICAL.Component(ICAL.parse(reply?.content ?? ''));
    const prop = calendar.getFirstSubcomponent('vevent')?.getFirstProperty('recurrence-id');
    expect(prop?.getParameter('tzid')).toBe('Europe/Paris');
    expect(String(prop?.getFirstValue())).toBe('2026-10-15T14:00:00');
    expect(calendar.getFirstSubcomponent('vtimezone')?.getFirstPropertyValue('tzid')).toBe(
      'Europe/Paris',
    );
  });

  it('refuse de répondre sans organisateur ou à autre chose qu’une demande', () => {
    expect(
      buildInvitationReply(GOOGLE.replace('METHOD:REQUEST', 'METHOD:CANCEL'), me, 'accepted'),
    ).toBeNull();
    expect(
      buildInvitationReply(GOOGLE.replace(/ORGANIZER[^\r]*\r\n/, ''), me, 'accepted'),
    ).toBeNull();
    expect(buildInvitationReply('nimporte quoi', me, 'accepted')).toBeNull();
  });

  it('message MIME : partie text/calendar; method=REPLY', async () => {
    const reply = buildInvitationReply(GOOGLE, me, 'tentative', now);
    const raw = (
      await buildMime({
        from: { name: 'Sacha', address: 'sacha@exemple.com' },
        to: [{ name: 'Alice Martin', address: 'alice@exemple.com' }],
        cc: [],
        bcc: [],
        subject: 'Provisoire : Point projet',
        html: '<p>Sacha a répondu « peut-être ».</p>',
        attachments: [],
        calendar: { method: 'REPLY', content: reply?.content ?? '' },
      })
    ).toString('utf8');
    expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/i);
  });
});
