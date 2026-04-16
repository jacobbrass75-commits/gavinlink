from django.contrib import admin

from .models import ChannelAccount


@admin.register(ChannelAccount)
class ChannelAccountAdmin(admin.ModelAdmin):
    list_display = ("name", "provider", "external_account_id", "is_active", "updated_at")
    list_filter = ("provider", "is_active")
    search_fields = ("name", "external_account_id")
    ordering = ("name",)

