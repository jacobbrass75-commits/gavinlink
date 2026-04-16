from django.contrib import admin

from .models import AIWorkItem


@admin.register(AIWorkItem)
class AIWorkItemAdmin(admin.ModelAdmin):
    list_display = ("task_name", "status", "updated_at")
    list_filter = ("status",)
    search_fields = ("task_name", "error_message")
    ordering = ("-created_at",)

