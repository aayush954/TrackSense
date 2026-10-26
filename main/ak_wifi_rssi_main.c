#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdbool.h>
#include <math.h>
#include <errno.h>
#include <stdint.h>
#include "esp_timer.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include "driver/i2c_master.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"

/* Configure with idf.py menuconfig; credentials are not stored in source. */
#define HOTSPOT_SSID       CONFIG_TRACKSENSE_WIFI_SSID
#define HOTSPOT_PASS       CONFIG_TRACKSENSE_WIFI_PASSWORD
#define PC_IP              CONFIG_TRACKSENSE_UDP_HOST
#define UDP_PORT           CONFIG_TRACKSENSE_UDP_PORT
/* Optional cloud uplink. Leave URL empty for local-only operation. */
#define TRACKSENSE_API_URL  CONFIG_TRACKSENSE_API_URL
#define TRACKSENSE_DEVICE_KEY CONFIG_TRACKSENSE_DEVICE_KEY
#define TRACKSENSE_DEVICE_ID CONFIG_TRACKSENSE_DEVICE_ID
#define TRACKSENSE_FIRMWARE_VERSION "1.0.0"
#define SCAN_INTERVAL_MS   10000
#define MOTION_POLL_INTERVAL_MS 50
#define OFFLINE_QUEUE_SIZE 3
#define TELEMETRY_BUFFER_SIZE 6000
#define WIFI_CONNECTED_BIT BIT0
#define MOTION_ACTIVE_BIT BIT1
#define SCAN_REQUESTED_BIT BIT2

/* XIAO ESP32-C6 + LIS3DH: SDA=D4/GPIO22, SCL=D5/GPIO23, SA0=GND => 0x18 */
#define I2C_SDA_GPIO 22
#define I2C_SCL_GPIO 23
#define LIS3DH_WHO_AM_I 0x0F
#define LIS3DH_CTRL1 0x20
#define LIS3DH_CTRL4 0x23
#define LIS3DH_OUT_X_L 0x28
#define MOTION_THRESHOLD_G 0.12f
#define MOTION_SAMPLE_THRESHOLD_G 0.08f
#define MOTION_HOLD_MS 5000

static const char *TAG = "wifi_rssi";
static EventGroupHandle_t wifi_events;
static int udp_sock = -1;
static bool udp_destination_valid = false;
static struct sockaddr_in dest_addr;
static i2c_master_bus_handle_t i2c_bus;
static i2c_master_dev_handle_t lis3dh;
static bool motion_sensor_ok = false;
static bool motion_reference_valid = false;
static bool motion_read_error_logged = false;
static float reference_gx = 0.0f;
static float reference_gy = 0.0f;
static float reference_gz = 0.0f;
static float previous_gx = 0.0f;
static float previous_gy = 0.0f;
static float previous_gz = 0.0f;
static int64_t last_motion_ms = 0;
static int64_t last_sample_log_ms = 0;
static char offline_payloads[OFFLINE_QUEUE_SIZE][TELEMETRY_BUFFER_SIZE];
static size_t offline_payload_count = 0;
static uint64_t telemetry_sequence = 0;

static bool append_json_string(char *buffer, size_t capacity, size_t *position,
                               const uint8_t *value, size_t length) {
    if (*position >= capacity || capacity - *position < 2) return false;
    buffer[(*position)++] = '"';
    for (size_t i = 0; i < length; ++i) {
        uint8_t byte = value[i];
        if (byte >= 0x20 && byte <= 0x7e && byte != '"' && byte != '\\') {
            if (*position + 1 >= capacity) return false;
            buffer[(*position)++] = (char)byte;
        } else {
            int written = snprintf(buffer + *position, capacity - *position,
                                   "\\u%04x", byte);
            if (written < 0 || (size_t)written >= capacity - *position) return false;
            *position += (size_t)written;
        }
    }
    if (*position + 1 >= capacity) return false;
    buffer[(*position)++] = '"';
    buffer[*position] = '\0';
    return true;
}

static esp_err_t lis3dh_read(uint8_t reg, uint8_t *data, size_t len) {
    if (!lis3dh) return ESP_FAIL;
    uint8_t address = reg | (len > 1 ? 0x80 : 0x00);
    return i2c_master_transmit_receive(lis3dh, &address, 1, data, len, 100);
}

static void motion_sensor_init(void) {
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = I2C_SDA_GPIO,
        .scl_io_num = I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &i2c_bus);
    if (err != ESP_OK) { ESP_LOGW(TAG, "I2C bus init failed: %s; motion sensing disabled", esp_err_to_name(err)); return; }
    /* Probe both standard LIS3DH I2C addresses: SA0 low=0x18, high=0x19. */
    uint8_t found_addr = 0;
    for (uint8_t candidate = 0x18; candidate <= 0x19; ++candidate) {
        i2c_device_config_t probe_cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = candidate, .scl_speed_hz = 100000 };
        i2c_master_dev_handle_t probe = NULL;
        esp_err_t probe_err = i2c_master_bus_add_device(i2c_bus, &probe_cfg, &probe);
        if (probe_err == ESP_OK) {
            uint8_t who_probe = 0;
            uint8_t reg = LIS3DH_WHO_AM_I;
            probe_err = i2c_master_transmit_receive(probe, &reg, 1, &who_probe, 1, 100);
            ESP_LOGI(TAG, "I2C probe address=0x%02x result=%s WHO_AM_I=0x%02x", candidate, esp_err_to_name(probe_err), who_probe);
            if (probe_err == ESP_OK && who_probe == 0x33) {
                lis3dh = probe; found_addr = candidate; break;
            }
            i2c_master_bus_rm_device(probe);
        }
    }
    if (!found_addr || !lis3dh) {
        ESP_LOGW(TAG, "LIS3DH not verified at 0x18 or 0x19; motion sensing disabled. Check 3V3/GND/SDA GPIO22/SCL GPIO23, CS=3V3, SA0=GND or 3V3, and actual sensor model.");
        lis3dh = NULL; return;
    }
    ESP_LOGI(TAG, "LIS3DH identity verified at I2C address 0x%02x", found_addr);
    uint8_t who = 0;
    err = lis3dh_read(LIS3DH_WHO_AM_I, &who, 1);
    if (err != ESP_OK || who != 0x33) { ESP_LOGW(TAG, "LIS3DH WHO_AM_I recheck failed (0x%02x); motion sensing disabled", who); lis3dh = NULL; return; }
    uint8_t config[] = { LIS3DH_CTRL1, 0x57 }; /* 100 Hz, XYZ enabled */
    err = i2c_master_transmit(lis3dh, config, sizeof(config), 100);
    if (err != ESP_OK) { ESP_LOGW(TAG, "LIS3DH CTRL1 configuration failed: %s", esp_err_to_name(err)); lis3dh = NULL; return; }
    uint8_t data_config[] = { LIS3DH_CTRL4, 0x88 }; /* BDU enabled, high-resolution, +/-2g */
    err = i2c_master_transmit(lis3dh, data_config, sizeof(data_config), 100);
    if (err != ESP_OK) { ESP_LOGW(TAG, "LIS3DH CTRL4 configuration failed: %s", esp_err_to_name(err)); lis3dh = NULL; return; }
    motion_sensor_ok = true;
    ESP_LOGI(TAG, "LIS3DH detected and enabled (WHO_AM_I=0x33, 100 Hz high-resolution)");
}

static void poll_motion(void) {
    if (!motion_sensor_ok) return;
    uint8_t raw[6];
    esp_err_t err = lis3dh_read(LIS3DH_OUT_X_L, raw, sizeof(raw));
    if (err != ESP_OK) {
        if (!motion_read_error_logged) ESP_LOGW(TAG, "LIS3DH data read failed: %s", esp_err_to_name(err));
        motion_read_error_logged = true;
        return;
    }
    if (motion_read_error_logged) ESP_LOGI(TAG, "LIS3DH data reads recovered");
    motion_read_error_logged = false;
    int16_t x = (int16_t)((uint16_t)raw[1] << 8 | raw[0]);
    int16_t y = (int16_t)((uint16_t)raw[3] << 8 | raw[2]);
    int16_t z = (int16_t)((uint16_t)raw[5] << 8 | raw[4]);
    /* High-resolution LIS3DH samples are 12-bit values left-aligned in 16 bits. */
    float gx = (float)(x / 16) / 1024.0f;
    float gy = (float)(y / 16) / 1024.0f;
    float gz = (float)(z / 16) / 1024.0f;
    int64_t now = esp_timer_get_time() / 1000;
    bool was_moving = (xEventGroupGetBits(wifi_events) & MOTION_ACTIVE_BIT) != 0;
    if (!motion_reference_valid) {
        reference_gx = gx;
        reference_gy = gy;
        reference_gz = gz;
        previous_gx = gx;
        previous_gy = gy;
        previous_gz = gz;
        motion_reference_valid = true;
    }
    float dx = gx - reference_gx;
    float dy = gy - reference_gy;
    float dz = gz - reference_gz;
    float delta_g = sqrtf(dx*dx + dy*dy + dz*dz);
    float sample_dx = gx - previous_gx;
    float sample_dy = gy - previous_gy;
    float sample_dz = gz - previous_gz;
    float sample_delta_g = sqrtf(sample_dx*sample_dx + sample_dy*sample_dy + sample_dz*sample_dz);
    if (sample_delta_g > MOTION_SAMPLE_THRESHOLD_G ||
        (!was_moving && delta_g > MOTION_THRESHOLD_G)) {
        last_motion_ms = now;
        xEventGroupSetBits(wifi_events, MOTION_ACTIVE_BIT);
        if (!was_moving) xEventGroupSetBits(wifi_events, SCAN_REQUESTED_BIT);
    } else if (was_moving && now - last_motion_ms >= MOTION_HOLD_MS) {
        xEventGroupClearBits(wifi_events, MOTION_ACTIVE_BIT);
        reference_gx = gx;
        reference_gy = gy;
        reference_gz = gz;
    }
    previous_gx = gx;
    previous_gy = gy;
    previous_gz = gz;
    if (now - last_sample_log_ms >= 1000) {
        last_sample_log_ms = now;
        ESP_LOGI(TAG, "Motion sample: X=%.2fg Y=%.2fg Z=%.2fg delta=%.2fg sample=%.2fg state=%s",
                 gx, gy, gz, delta_g, sample_delta_g,
                 (xEventGroupGetBits(wifi_events) & MOTION_ACTIVE_BIT) ? "MOVING" : "stationary");
    }
    if (!was_moving && (xEventGroupGetBits(wifi_events) & MOTION_ACTIVE_BIT)) {
        ESP_LOGI(TAG, "Motion detected (axis change %.2fg)", delta_g);
    }
    if (was_moving && !(xEventGroupGetBits(wifi_events) & MOTION_ACTIVE_BIT)) {
        ESP_LOGI(TAG, "Motion stopped");
    }
}

static void motion_monitor_task(void *arg) {
    (void)arg;
    while (true) {
        poll_motion();
        vTaskDelay(pdMS_TO_TICKS(MOTION_POLL_INTERVAL_MS));
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events, WIFI_CONNECTED_BIT);
        if (udp_sock >= 0) { close(udp_sock); udp_sock = -1; }
        udp_destination_valid = false;
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "Wi-Fi disconnected. Reason=%d; scanning continues offline",
                 event ? event->reason : -1);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Connected. ESP32 IP: " IPSTR, IP2STR(&event->ip_info.ip));
        if (udp_sock >= 0) close(udp_sock);
        udp_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
        if (udp_sock < 0) ESP_LOGE(TAG, "UDP socket creation failed");
        else {
            memset(&dest_addr, 0, sizeof(dest_addr));
            dest_addr.sin_family = AF_INET;
            dest_addr.sin_port = htons(UDP_PORT);
            if (inet_pton(AF_INET, PC_IP, &dest_addr.sin_addr) != 1) ESP_LOGE(TAG, "Invalid PC_IP: %s", PC_IP);
            else {
                udp_destination_valid = true;
                ESP_LOGI(TAG, "UDP telemetry destination %s:%d", PC_IP, UDP_PORT);
            }
        }
        xEventGroupSetBits(wifi_events, WIFI_CONNECTED_BIT);
    }
}

static esp_err_t wifi_init_sta(void) {
    if (HOTSPOT_SSID[0] == '\0') {
        ESP_LOGW(TAG, "No telemetry Wi-Fi SSID configured; scanning continues without uplink");
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));
    wifi_config_t sta_config = {0};
    strncpy((char *)sta_config.sta.ssid, HOTSPOT_SSID, sizeof(sta_config.sta.ssid)-1);
    strncpy((char *)sta_config.sta.password, HOTSPOT_PASS, sizeof(sta_config.sta.password)-1);
    sta_config.sta.threshold.authmode = strlen(HOTSPOT_PASS) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_err_t ps_err = esp_wifi_set_ps(WIFI_PS_MAX_MODEM);
    if (ps_err != ESP_OK) ESP_LOGW(TAG, "Could not enable Wi-Fi modem power save: %s", esp_err_to_name(ps_err));
    return ESP_OK;
}

static bool cloud_send_payload(const char *payload) {
    if (TRACKSENSE_API_URL[0] == '\0' ||
        strcmp(TRACKSENSE_DEVICE_KEY, "SET_THE_RENDER_DEVICE_API_KEY_HERE") == 0 ||
        TRACKSENSE_DEVICE_KEY[0] == '\0') {
        return false;
    }
    if (strncmp(TRACKSENSE_API_URL, "https://", 8) != 0) {
        ESP_LOGE(TAG, "Cloud telemetry URL must use HTTPS");
        return false;
    }
    esp_http_client_config_t config = {
        .url = TRACKSENSE_API_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 7000,
        .disable_auto_redirect = true,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) { ESP_LOGW(TAG, "Cloud HTTP client init failed"); return false; }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Device-Key", TRACKSENSE_DEVICE_KEY);
    esp_http_client_set_header(client, "X-Device-Id", TRACKSENSE_DEVICE_ID);
    esp_http_client_set_post_field(client, payload, (int)strlen(payload));
    esp_err_t err = esp_http_client_perform(client);
    bool accepted = false;
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        if (status >= 200 && status < 300) { ESP_LOGI(TAG, "Cloud telemetry accepted (HTTP %d)", status); accepted = true; }
        else ESP_LOGW(TAG, "Cloud telemetry rejected (HTTP %d); check API key/service logs", status);
    } else {
        ESP_LOGW(TAG, "Cloud telemetry upload failed: %s", esp_err_to_name(err));
    }
    esp_http_client_cleanup(client);
    return accepted;
}

static void queue_offline_payload(const char *payload) {
    if (offline_payload_count == OFFLINE_QUEUE_SIZE) {
        memmove(offline_payloads[0], offline_payloads[1],
                (OFFLINE_QUEUE_SIZE - 1) * TELEMETRY_BUFFER_SIZE);
        offline_payload_count--;
        ESP_LOGW(TAG, "Offline queue full; dropping oldest buffered scan");
    }
    snprintf(offline_payloads[offline_payload_count], TELEMETRY_BUFFER_SIZE, "%s", payload);
    offline_payload_count++;
    ESP_LOGI(TAG, "Buffered scan offline; queue=%u/%u",
             (unsigned)offline_payload_count, (unsigned)OFFLINE_QUEUE_SIZE);
}

static bool send_payload(const char *payload) {
    if (!(xEventGroupGetBits(wifi_events) & WIFI_CONNECTED_BIT)) return false;
    if (TRACKSENSE_API_URL[0] != '\0') return cloud_send_payload(payload);
    if (udp_sock >= 0 && udp_destination_valid) {
        int sent = sendto(udp_sock, payload, strlen(payload), 0,
                          (struct sockaddr *)&dest_addr, sizeof(dest_addr));
        if (sent < 0) ESP_LOGW(TAG, "UDP send failed: errno=%d", errno);
        else return true;
    }
    return false;
}

static void flush_offline_queue(void) {
    while (offline_payload_count > 0 && send_payload(offline_payloads[0])) {
        offline_payload_count--;
        if (offline_payload_count > 0) {
            memmove(offline_payloads[0], offline_payloads[1],
                    offline_payload_count * TELEMETRY_BUFFER_SIZE);
        }
        ESP_LOGI(TAG, "Buffered scan sent; queue=%u/%u",
                 (unsigned)offline_payload_count, (unsigned)OFFLINE_QUEUE_SIZE);
    }
}

static void scan_and_send(void) {
    esp_err_t err = esp_wifi_scan_start(NULL, true);
    if (err != ESP_OK) { ESP_LOGW(TAG, "Wi-Fi scan failed: %s", esp_err_to_name(err)); return; }
    uint16_t count = 0;
    err = esp_wifi_scan_get_ap_num(&count);
    if (err != ESP_OK) { ESP_LOGW(TAG, "Cannot read scan result count: %s", esp_err_to_name(err)); return; }
    wifi_ap_record_t *aps = count ? calloc(count, sizeof(*aps)) : NULL;
    if (count && !aps) { ESP_LOGE(TAG, "Out of memory for AP list"); return; }
    uint16_t capacity = count;
    if (count) {
        err = esp_wifi_scan_get_ap_records(&capacity, aps);
        if (err != ESP_OK) { ESP_LOGE(TAG, "Cannot read AP records: %s", esp_err_to_name(err)); free(aps); return; }
    }
    char *buf = calloc(1, TELEMETRY_BUFFER_SIZE);
    if (!buf) { free(aps); ESP_LOGE(TAG, "Out of memory for telemetry payload"); return; }
    bool moving = (xEventGroupGetBits(wifi_events) & MOTION_ACTIVE_BIT) != 0;
    bool wifi_connected = (xEventGroupGetBits(wifi_events) & WIFI_CONNECTED_BIT) != 0;
    uint64_t sequence = ++telemetry_sequence;
    uint32_t scan_nonce_high = esp_random();
    uint32_t scan_nonce_low = esp_random();
    int64_t uptime_ms = esp_timer_get_time() / 1000;
    int pos=snprintf(buf, TELEMETRY_BUFFER_SIZE,
        "{\"schemaVersion\":1,\"scanId\":\"%08lx%08lx-%llu\",\"sequence\":%llu,"
        "\"deviceTimestampMs\":%lld,\"firmwareVersion\":\"%s\",\"deviceId\":",
        (unsigned long)scan_nonce_high,(unsigned long)scan_nonce_low,
        (unsigned long long)sequence,
        (unsigned long long)sequence,(long long)uptime_ms,TRACKSENSE_FIRMWARE_VERSION);
    size_t payload_position = pos > 0 ? (size_t)pos : 0;
    if (pos < 0 || payload_position >= TELEMETRY_BUFFER_SIZE ||
        !append_json_string(buf,TELEMETRY_BUFFER_SIZE,&payload_position,
                            (const uint8_t *)TRACKSENSE_DEVICE_ID,strlen(TRACKSENSE_DEVICE_ID))) {
        ESP_LOGE(TAG, "Could not encode telemetry device identifier");
        free(buf); free(aps); return;
    }
    pos = (int)payload_position;
    int written = snprintf(buf+pos,TELEMETRY_BUFFER_SIZE-(size_t)pos,
        ",\"motionState\":\"%s\",\"sensorStatus\":\"%s\",\"wifiConnected\":%s,"
        "\"batteryVoltage\":null,\"batteryPercent\":null,\"observations\":[",
        motion_sensor_ok?(moving?"moving":"stationary"):"unavailable",
        motion_sensor_ok?"ok":"unavailable",wifi_connected?"true":"false");
    if (written < 0 || (size_t)written >= TELEMETRY_BUFFER_SIZE-(size_t)pos) {
        ESP_LOGE(TAG, "Telemetry header exceeds the payload buffer");
        free(buf); free(aps); return;
    }
    pos += written;
    size_t observation_count = 0;
    for (int i=0; i<capacity && i<100 && pos > 0; i++) {
        char observation[320];
        size_t observation_pos = 0;
        written = snprintf(observation, sizeof(observation),
            "{\"bssid\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"ssid\":",
            (unsigned)aps[i].bssid[0],(unsigned)aps[i].bssid[1],
            (unsigned)aps[i].bssid[2],(unsigned)aps[i].bssid[3],
            (unsigned)aps[i].bssid[4],(unsigned)aps[i].bssid[5]);
        if (written < 0 || (size_t)written >= sizeof(observation)) break;
        observation_pos = (size_t)written;
        size_t ssid_length = 0;
        while (ssid_length < sizeof(aps[i].ssid) && aps[i].ssid[ssid_length]) ssid_length++;
        if (!append_json_string(observation,sizeof(observation),&observation_pos,
                                aps[i].ssid,ssid_length)) break;
        written = snprintf(observation+observation_pos,sizeof(observation)-observation_pos,
            ",\"rssi\":%d,\"channel\":%d}",aps[i].rssi,aps[i].primary);
        if (written < 0 || (size_t)written >= sizeof(observation)-observation_pos) break;
        observation_pos += (size_t)written;
        size_t separator_length = observation_count ? 1 : 0;
        if ((size_t)pos + separator_length + observation_pos + 3 >= TELEMETRY_BUFFER_SIZE) break;
        if (separator_length) buf[pos++] = ',';
        memcpy(buf+pos,observation,observation_pos);
        pos += (int)observation_pos;
        buf[pos] = '\0';
        observation_count++;
        ESP_LOGI(TAG, "AP %s RSSI=%d dBm channel=%d", (char *)aps[i].ssid, aps[i].rssi, aps[i].primary);
    }
    if (observation_count < capacity) {
        ESP_LOGW(TAG, "Telemetry payload includes %u of %u scanned APs",
                 (unsigned)observation_count, (unsigned)capacity);
    }
    if (pos < 0 || pos >= TELEMETRY_BUFFER_SIZE-3) {
        ESP_LOGE(TAG, "Telemetry JSON exceeds the payload buffer");
        free(buf); free(aps); return;
    }
    buf[pos++] = ']';
    buf[pos++] = '}';
    buf[pos] = '\0';
    ESP_LOGI(TAG, "Scan complete: %u APs; motion=%s; Wi-Fi=%s",
             capacity, moving ? "MOVING" : "stationary", wifi_connected ? "connected" : "offline");
    if (offline_payload_count > 0) flush_offline_queue();
    if (!send_payload(buf)) queue_offline_payload(buf);
    free(buf); free(aps);
}

void app_main(void) {
    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs);
    wifi_events = xEventGroupCreate();
    if (!wifi_events) ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
    motion_sensor_init();
    ESP_ERROR_CHECK(wifi_init_sta());
    if (motion_sensor_ok) {
        BaseType_t task_err = xTaskCreate(motion_monitor_task, "motion_monitor", 4096, NULL, 5, NULL);
        if (task_err != pdPASS) {
            ESP_LOGE(TAG, "Could not create motion monitor task");
            motion_sensor_ok = false;
        }
    }
    int64_t last_scan_ms = 0;
    while (1) {
        scan_and_send();
        last_scan_ms = esp_timer_get_time() / 1000;
        while (true) {
            EventBits_t bits = xEventGroupGetBits(wifi_events);
            if (bits & SCAN_REQUESTED_BIT) {
                xEventGroupClearBits(wifi_events, SCAN_REQUESTED_BIT);
                break;
            }
            int64_t elapsed_ms = esp_timer_get_time() / 1000 - last_scan_ms;
            if (elapsed_ms >= SCAN_INTERVAL_MS) break;
            TickType_t remaining_ticks = pdMS_TO_TICKS(SCAN_INTERVAL_MS - elapsed_ms);
            if (remaining_ticks == 0) remaining_ticks = 1;
            xEventGroupWaitBits(wifi_events, SCAN_REQUESTED_BIT, pdTRUE, pdFALSE, remaining_ticks);
            bits = xEventGroupGetBits(wifi_events);
            if (bits & SCAN_REQUESTED_BIT) break;
        }
    }
}
