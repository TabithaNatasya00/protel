#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <vector>

const char* ssid = "Apa Ya";
const char* password = "Wh04r3Y0u";
const char* serverUrl = "https://www.circuitdigest.cloud/geolinker";
const char* apiKey = "MKAIUFXlri0r";

HardwareSerial gpsSerial(1);
const int RXPin = 16;
const int TXPin = 17;

struct GPSRawData {
  double latitude;
  char latitudeDir;
  double longitude;
  char longitudeDir;
  int satellites;
  double altitude;
  int hours, minutes, seconds;
  int day, month, year;
  String timestamp;
};

struct GPSData {
  double latitude;
  double longitude;
  String timestamp;
};

void processGPSData(String raw);
void parseGPGGA(String data);
void parseGPRMC(String data);
void convertAndPrintLocalDateTime();
double convertToDecimal(float raw, char dir);
bool sendGPSData(GPSData data);

const unsigned long uploadInterval = 10000;
unsigned long lastUploadTime = 0;
const int networkStatusLED = 18;
const int gpsStatusLED = 19;

bool gpsDataValid = false;
GPSData latestGPSData;
GPSRawData latestGPSRawData;
std::vector<GPSData> offlineData;

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, RXPin, TXPin);

  pinMode(networkStatusLED, OUTPUT);
  pinMode(gpsStatusLED, OUTPUT);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(networkStatusLED, LOW);
    delay(500);
    digitalWrite(networkStatusLED, HIGH);
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected!");
  digitalWrite(networkStatusLED, HIGH);
}

void loop() {
  static String gpsData = "";

  while (gpsSerial.available()) {
    char c = gpsSerial.read();
    gpsData += c;
    if (c == '\n') {
      processGPSData(gpsData);
      gpsData = "";
    }
  }

  if (millis() - lastUploadTime >= uploadInterval) {
    lastUploadTime = millis();

    if (gpsDataValid) {
      if (WiFi.status() == WL_CONNECTED) {
        digitalWrite(networkStatusLED, HIGH);

        bool offlineUploadSuccess = true;
        for (auto& data : offlineData) {
          if (!sendGPSData(data)) {
            offlineUploadSuccess = false;
            break;
          }
        }
        if (offlineUploadSuccess) {
          offlineData.clear();
        }

        if (!sendGPSData(latestGPSData)) {
          Serial.println("Failed to upload latest GPS data. Storing locally.");
          offlineData.push_back(latestGPSData);
          digitalWrite(networkStatusLED, LOW);
        } else {
          Serial.println("Latest GPS data uploaded successfully.");
        }

      } else {
        Serial.println("WiFi not connected. Storing data locally.");
        offlineData.push_back(latestGPSData);
        digitalWrite(networkStatusLED, LOW);
        WiFi.disconnect();
        WiFi.reconnect();
      }
    } else {
      Serial.println("Invalid GPS data. Skipping upload.");
    }
  }
}

bool sendGPSData(GPSData data) {
  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", apiKey);  // Perlu untuk validasi

  String payload = R"({
    "timestamp": [")" + data.timestamp + R"("],
    "lat": [)" + String(data.latitude, 6) + R"(],
    "long": [)" + String(data.longitude, 6) + R"(]
  })";

  Serial.println("Payload:");
  Serial.println(payload);

  int httpResponseCode = http.POST(payload);
  Serial.print("Server response code: ");
  Serial.println(httpResponseCode);
  http.end();

  return (httpResponseCode == 200 || httpResponseCode == 201);
}

void processGPSData(String raw) {
  if (raw.startsWith("$GPGGA")) {
    parseGPGGA(raw);
    convertAndPrintLocalDateTime();
  } else if (raw.startsWith("$GPRMC")) {
    parseGPRMC(raw);
  }
}

void parseGPGGA(String data) {
  int idx = 0;
  String parts[15];
  for (int i = 0; i < 15; i++) {
    int comma = data.indexOf(',', idx);
    if (comma == -1) break;
    parts[i] = data.substring(idx, comma);
    idx = comma + 1;
  }

  latestGPSRawData.latitude = convertToDecimal(parts[2].toFloat(), parts[3].charAt(0));
  latestGPSRawData.latitudeDir = parts[3].charAt(0);
  latestGPSRawData.longitude = convertToDecimal(parts[4].toFloat(), parts[5].charAt(0));
  latestGPSRawData.longitudeDir = parts[5].charAt(0);
  latestGPSRawData.satellites = parts[7].toInt();
  latestGPSRawData.altitude = parts[9].toFloat();

  gpsDataValid = (latestGPSRawData.latitude != 0 && latestGPSRawData.longitude != 0);
}

void parseGPRMC(String data) {
  int idx = 0;
  String parts[12];
  for (int i = 0; i < 12; i++) {
    int comma = data.indexOf(',', idx);
    if (comma == -1) break;
    parts[i] = data.substring(idx, comma);
    idx = comma + 1;
  }

  if (parts[2] == "A") {  // 'A' = data valid
    String timeStr = parts[1]; // hhmmss.ss
    latestGPSRawData.hours = timeStr.substring(0, 2).toInt();
    latestGPSRawData.minutes = timeStr.substring(2, 4).toInt();
    latestGPSRawData.seconds = timeStr.substring(4, 6).toInt();

    String dateStr = parts[9]; // ddmmyy
    latestGPSRawData.day = dateStr.substring(0, 2).toInt();
    latestGPSRawData.month = dateStr.substring(2, 4).toInt();
    latestGPSRawData.year = 2000 + dateStr.substring(4, 6).toInt();

    char buffer[30];
    sprintf(buffer, "%04d-%02d-%02dT%02d:%02d:%02dZ",
            latestGPSRawData.year,
            latestGPSRawData.month,
            latestGPSRawData.day,
            latestGPSRawData.hours,
            latestGPSRawData.minutes,
            latestGPSRawData.seconds);
    latestGPSRawData.timestamp = String(buffer);

    latestGPSData.latitude = latestGPSRawData.latitude;
    latestGPSData.longitude = latestGPSRawData.longitude;
    latestGPSData.timestamp = latestGPSRawData.timestamp;
  }
}

double convertToDecimal(float raw, char dir) {
  int degrees = int(raw / 100);
  float minutes = raw - (degrees * 100);
  double decimal = degrees + (minutes / 60.0);
  return (dir == 'S' || dir == 'W') ? -decimal : decimal;
}

void convertAndPrintLocalDateTime() {
  Serial.print("Time: ");
  Serial.print(latestGPSRawData.hours); Serial.print(":");
  Serial.print(latestGPSRawData.minutes); Serial.print(":");
  Serial.println(latestGPSRawData.seconds);

  Serial.print("Date: ");
  Serial.print(latestGPSRawData.day); Serial.print("-");
  Serial.print(latestGPSRawData.month); Serial.print("-");
  Serial.println(latestGPSRawData.year);

  Serial.print("Lat: "); Serial.println(latestGPSRawData.latitude, 6);
  Serial.print("Long: "); Serial.println(latestGPSRawData.longitude, 6);
  Serial.print("Altitude: "); Serial.println(latestGPSRawData.altitude);
  Serial.print("Satellites: "); Serial.println(latestGPSRawData.satellites);
  Serial.print("Timestamp: "); Serial.println(latestGPSRawData.timestamp);
}
