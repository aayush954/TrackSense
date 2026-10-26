idf_component_register(
    SRCS "ak_wifi_rssi_main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES
        esp_timer
        esp_wifi
        esp_event
        esp_netif
        nvs_flash
        lwip
        esp_driver_i2c
        esp_driver_gpio
        esp_http_client
        esp-tls
        mbedtls
)
