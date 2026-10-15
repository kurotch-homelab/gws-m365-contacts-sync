import type { Contact, Fields, Json } from '../sync/model.js';
export const googleMask =
  'names,emailAddresses,phoneNumbers,organizations,addresses,biographies,urls,metadata,userDefined';
export const graphSelect =
  'id,changeKey,givenName,surname,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,department,jobTitle,homeAddress,businessAddress,otherAddress,personalNotes,businessHomePage';
export const markerId =
  'String {5fd4a562-fdae-4528-867a-b111154818c4} Name ContactsSyncOperation';
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? (x as Obj) : {});
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? x.map(obj) : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const sorted = (xs: Json[]) =>
  xs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export class MappingError extends Error {
  constructor() {
    super('lossy_mapping_requires_review');
  }
}
export function googleContact(raw: Obj): Contact {
  const names = arr(raw.names),
    orgs = arr(raw.organizations),
    n = names[0] ?? {},
    o = orgs[0] ?? {};
  const fields: Fields = {
    givenName: str(n.givenName),
    surname: str(n.familyName),
    displayName: str(n.unstructuredName) || str(n.displayName),
    emails: sorted(arr(raw.emailAddresses).map((e) => str(e.value))),
    phones: sorted(
      arr(raw.phoneNumbers).map((p) => ({
        value: str(p.value),
        type: str(p.type) || 'other',
      })),
    ),
    company: str(o.name),
    department: str(o.department),
    jobTitle: str(o.title),
    addresses: sorted(
      arr(raw.addresses).map((a) => ({
        type: str(a.type) || 'other',
        street: str(a.streetAddress),
        city: str(a.city),
        state: str(a.region),
        postalCode: str(a.postalCode),
        countryOrRegion: str(a.country),
      })),
    ),
    notes: str(arr(raw.biographies)[0]?.value),
    websites: sorted(arr(raw.urls).map((u) => str(u.value))),
  };
  return {
    id: str(raw.resourceName),
    etag: str(raw.etag),
    raw,
    fields,
    deleted: obj(raw.metadata).deleted === true,
    marker:
      str(
        arr(raw.userDefined).find((p) => p.key === 'contacts-sync-operation')
          ?.value,
      ) || undefined,
  };
}
export function graphContact(raw: Obj): Contact {
  const phones: Json[] = [];
  for (const [key, type] of [
    ['homePhones', 'home'],
    ['businessPhones', 'work'],
  ] as const)
    for (const value of (raw[key] as string[]) ?? [])
      phones.push({ value, type });
  if (raw.mobilePhone)
    phones.push({ value: str(raw.mobilePhone), type: 'mobile' });
  const addresses: Json[] = [];
  for (const [key, type] of [
    ['homeAddress', 'home'],
    ['businessAddress', 'work'],
    ['otherAddress', 'other'],
  ] as const) {
    const a = obj(raw[key]);
    if (Object.values(a).some(Boolean))
      addresses.push({
        type,
        street: str(a.street),
        city: str(a.city),
        state: str(a.state),
        postalCode: str(a.postalCode),
        countryOrRegion: str(a.countryOrRegion),
      });
  }
  return {
    id: str(raw.id),
    etag:
      str(raw['@odata.etag']) ||
      (raw.changeKey ? `W/"${str(raw.changeKey)}"` : ''),
    raw,
    deleted: !!raw['@removed'],
    marker:
      str(
        arr(raw.singleValueExtendedProperties).find((p) => p.id === markerId)
          ?.value,
      ) || undefined,
    fields: {
      givenName: str(raw.givenName),
      surname: str(raw.surname),
      displayName: str(raw.displayName),
      emails: sorted(arr(raw.emailAddresses).map((e) => str(e.address))),
      phones: sorted(phones),
      company: str(raw.companyName),
      department: str(raw.department),
      jobTitle: str(raw.jobTitle),
      addresses: sorted(addresses),
      notes: str(raw.personalNotes),
      websites: raw.businessHomePage ? [str(raw.businessHomePage)] : [],
    },
  };
}
export function googlePatch(fields: Fields, raw: Obj = {}): Obj {
  const patch: Obj = {};
  if (['givenName', 'surname', 'displayName'].some((k) => k in fields)) {
    const previous = arr(raw.names);
    if (previous.length > 1) throw new MappingError();
    patch.names = [
      {
        ...previous[0],
        ...('givenName' in fields ? { givenName: fields.givenName } : {}),
        ...('surname' in fields ? { familyName: fields.surname } : {}),
        ...('displayName' in fields
          ? { unstructuredName: fields.displayName }
          : {}),
      },
    ];
  }
  if ('emails' in fields)
    patch.emailAddresses = (fields.emails as string[]).map((value) => ({
      ...arr(raw.emailAddresses).find((e) => e.value === value),
      value,
    }));
  if ('phones' in fields)
    patch.phoneNumbers = (fields.phones as Obj[]).map((p) => ({
      ...arr(raw.phoneNumbers).find(
        (e) => e.value === p.value && e.type === p.type,
      ),
      ...p,
    }));
  if (['company', 'department', 'jobTitle'].some((k) => k in fields)) {
    const previous = arr(raw.organizations);
    if (previous.length > 1) throw new MappingError();
    patch.organizations = [
      {
        ...previous[0],
        ...('company' in fields ? { name: fields.company } : {}),
        ...('department' in fields ? { department: fields.department } : {}),
        ...('jobTitle' in fields ? { title: fields.jobTitle } : {}),
      },
    ];
  }
  if ('addresses' in fields)
    patch.addresses = (fields.addresses as Obj[]).map((a) => ({
      ...arr(raw.addresses).find((e) => e.type === a.type),
      type: a.type,
      streetAddress: a.street,
      city: a.city,
      region: a.state,
      postalCode: a.postalCode,
      country: a.countryOrRegion,
    }));
  if ('notes' in fields) {
    if (
      arr(raw.biographies).some(
        (b) => b.contentType && b.contentType !== 'TEXT_PLAIN',
      )
    )
      throw new MappingError();
    patch.biographies = [{ value: fields.notes, contentType: 'TEXT_PLAIN' }];
  }
  if ('websites' in fields)
    patch.urls = (fields.websites as string[]).map((value) => ({
      ...arr(raw.urls).find((u) => u.value === value),
      value,
    }));
  // Metadata inside field entries is output-only. Keep provider-only writable properties.
  for (const value of Object.values(patch))
    if (Array.isArray(value))
      for (const entry of value) {
        delete entry.metadata;
        delete entry.formattedType;
        delete entry.displayName;
        delete entry.displayNameLastFirst;
      }
  return patch;
}
export function graphPatch(fields: Fields, raw: Obj = {}): Obj {
  const patch: Obj = {};
  for (const [field, target] of Object.entries({
    givenName: 'givenName',
    surname: 'surname',
    displayName: 'displayName',
    company: 'companyName',
    department: 'department',
    jobTitle: 'jobTitle',
    notes: 'personalNotes',
  }))
    if (field in fields) patch[target] = fields[field];
  if ('emails' in fields)
    patch.emailAddresses = (fields.emails as string[]).map((address) => ({
      ...arr(raw.emailAddresses).find((e) => e.address === address),
      address,
    }));
  if ('phones' in fields) {
    const phones = fields.phones as Obj[];
    if (
      phones.some((p) => !['home', 'work', 'mobile'].includes(str(p.type))) ||
      phones.filter((p) => p.type === 'mobile').length > 1
    )
      throw new MappingError();
    patch.homePhones = phones
      .filter((p) => p.type === 'home')
      .map((p) => p.value);
    patch.businessPhones = phones
      .filter((p) => p.type === 'work')
      .map((p) => p.value);
    patch.mobilePhone = phones.find((p) => p.type === 'mobile')?.value ?? null;
  }
  if ('addresses' in fields) {
    const addresses = fields.addresses as Obj[];
    if (
      addresses.some((a) => !['home', 'work', 'other'].includes(str(a.type))) ||
      new Set(addresses.map((a) => a.type)).size !== addresses.length
    )
      throw new MappingError();
    for (const [type, key] of [
      ['home', 'homeAddress'],
      ['work', 'businessAddress'],
      ['other', 'otherAddress'],
    ] as const) {
      const address = addresses.find((a) => a.type === type);
      patch[key] = address
        ? Object.fromEntries(
            Object.entries(address).filter(([k]) => k !== 'type'),
          )
        : {
            street: '',
            city: '',
            state: '',
            postalCode: '',
            countryOrRegion: '',
          };
    }
  }
  if ('websites' in fields) {
    const sites = fields.websites as string[];
    if (sites.length > 1) throw new MappingError();
    patch.businessHomePage = sites[0] ?? '';
  }
  // Graph can otherwise regenerate displayName when unrelated fields change.
  if (
    Object.keys(patch).length &&
    !('displayName' in patch) &&
    typeof raw.displayName === 'string'
  )
    patch.displayName = raw.displayName;
  return patch;
}
