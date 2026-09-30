import { Faker, en, base } from "@faker-js/faker";

// Reviewed, zero-required-argument scalar methods. No helpers, arbitrary code,
// structured results, real email domains, or payment credentials.
const methods = {
  person:
    "firstName lastName middleName fullName gender sex prefix suffix bio jobTitle jobDescriptor jobArea jobType zodiacSign",
  location:
    "zipCode city buildingNumber street streetAddress secondaryAddress county country continent countryCode state direction cardinalDirection ordinalDirection timeZone latitude longitude",
  internet:
    "exampleEmail username displayName protocol httpMethod httpStatusCode domainSuffix domainWord ipv4 ipv6 port userAgent mac password emoji jwtAlgorithm",
  company:
    "name catchPhrase buzzPhrase catchPhraseAdjective catchPhraseDescriptor catchPhraseNoun buzzAdjective buzzVerb buzzNoun",
  commerce:
    "department productName price productAdjective productMaterial product productDescription isbn upc",
  lorem: "word words sentence slug sentences paragraph paragraphs text lines",
  animal:
    "dog cat snake bear lion cetacean horse bird cow fish crocodilia insect rabbit rodent type petName",
  book: "author format genre publisher series title",
  food: "adjective description dish ethnicCategory fruit ingredient meat spice vegetable",
  music: "album artist genre songName",
  vehicle: "vehicle manufacturer model type fuel vin color vrm bicycle",
  finance:
    "accountName amount transactionType currencyCode currencyName currencySymbol currencyNumericCode transactionDescription",
  database: "column type collation engine mongodbObjectId",
  hacker: "abbreviation adjective noun verb ingverb phrase",
  git: "branch commitMessage commitSha",
  system:
    "fileName commonFileName mimeType commonFileType commonFileExt fileType fileExt directoryPath filePath semver networkInterface cron",
  string: "alpha alphanumeric numeric uuid nanoid",
  number: "int float binary octal hex romanNumeral",
  color: "human rgb",
  phone: "number imei",
  airline: "recordLocator seat aircraftType flightNumber",
  word: "adjective adverb conjunction interjection noun preposition verb sample words",
} as const;

/** Catalog IDs are executable only through this host-owned registry. */
export function goalGenerators(seed: number): {
  descriptions: Record<string, string>;
  generate: (id: string) => string;
} {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);
  const functions = new Map<string, () => unknown>();
  const descriptions: Record<string, string> = {};
  for (const [module, names] of Object.entries(methods)) {
    const instance = faker[module as keyof typeof methods] as unknown as Record<
      string,
      () => unknown
    >;
    for (const name of names.split(" ")) {
      const id = `faker.${module}.${name}`;
      descriptions[id] =
        `Generate NEW synthetic ${module}: ${name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`;
      functions.set(id, () => instance[name]!());
    }
  }
  descriptions["faker.internet.exampleEmail"] =
    "Generate NEW synthetic email on a reserved example domain; not an existing account or inbox";
  descriptions["faker.internet.password"] =
    "Generate NEW account password; NEVER an existing login credential or OTP";
  return {
    descriptions,
    generate(id) {
      const fn = functions.get(id);
      if (!fn) throw new Error("Unknown goal generator");
      const value = fn();
      if (!["string", "number", "boolean"].includes(typeof value))
        throw new Error("Generator did not return a scalar");
      const text = String(value);
      if (!text.trim() || text.length > 2000)
        throw new Error("Generator returned an unsupported value");
      return text;
    },
  };
}
